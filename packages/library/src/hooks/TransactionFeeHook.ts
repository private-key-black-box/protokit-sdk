/* eslint-disable import/no-unused-modules */
import {
  getAllPropertyNames,
  isRuntimeMethod,
  Runtime,
  RuntimeModulesRecord,
} from "@proto-kit/module";
import { inject, injectable } from "tsyringe";
import {
  ProvableTransactionHook,
  BlockProverExecutionData,
  PublicKeyOption,
} from "@proto-kit/protocol";
import { Field, Provable, PublicKey, UInt64 as O1JSUInt64 } from "o1js";

import { UInt64 } from "../math/UInt64";
import { Balance, TokenId } from "../runtime/Balances";

import {
  MethodFeeConfigData,
  RuntimeFeeAnalyzerService,
  RuntimeFeeAnalyzerServiceConfig,
} from "./RuntimeFeeAnalyzerService";

interface Balances {
  transfer: (
    tokenId: TokenId,
    from: PublicKey,
    to: PublicKey,
    amount: Balance
  ) => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TransactionFeeHookConfig
  extends RuntimeFeeAnalyzerServiceConfig {}

const errors = {
  invalidFeeTreeRoot: () =>
    "Root hash of the provided fee config witness is invalid",

  invalidFeeConfigMethodId: () =>
    "Method id of the provided fee config does not match the executed transaction method id",

  invalidMethod: (method: string) =>
    `${method} does not exist in the current runtime.`,
};

/**
 * Transaction hook for deducting transaction fees from the sender's balance.
 */
@injectable()
export class TransactionFeeHook extends ProvableTransactionHook<TransactionFeeHookConfig> {
  public constructor(
    // dependency on runtime, since balances are part of runtime logic
    @inject("Runtime") public runtime: Runtime<RuntimeModulesRecord>
  ) {
    super();
  }

  protected persistedFeeAnalyzer: RuntimeFeeAnalyzerService | null = null;

  // check if the fee config is compatible with the current runtime
  // we couldnt resolve this purely on the type level, so we have to do it here
  public verifyConfig() {
    Object.keys(super.config.methods).forEach((combinedMethodName) => {
      const [runtimeModule, runtimeMethod] = combinedMethodName.split(".");
      const resolvedRuntimeModule = this.runtime.resolve(runtimeModule);

      const runtimeMethodExists =
        getAllPropertyNames(resolvedRuntimeModule).includes(runtimeMethod) &&
        isRuntimeMethod(resolvedRuntimeModule, runtimeMethod);

      if (!runtimeMethodExists) {
        throw errors.invalidMethod(combinedMethodName);
      }
    });
  }

  public get config() {
    this.verifyConfig();
    return super.config;
  }

  public set config(value: TransactionFeeHookConfig) {
    super.config = value;
  }

  public get balances() {
    return this.runtime.dependencyContainer.resolve<Balances>("Balances");
  }

  public get feeAnalyzer() {
    if (this.persistedFeeAnalyzer) return this.persistedFeeAnalyzer;
    this.persistedFeeAnalyzer = new RuntimeFeeAnalyzerService(this.runtime);
    this.persistedFeeAnalyzer.config = this.config;
    return this.persistedFeeAnalyzer;
  }

  public transferFee(from: PublicKeyOption, fee: UInt64) {
    this.balances.transfer(
      new TokenId(this.config.tokenId),
      from.value,
      PublicKey.fromBase58(this.config.feeRecipient),
      Balance.from(fee.value)
    );
  }

  /**
   * Determine the transaction fee for the given transaction, and transfer it
   * from the transaction sender to the fee recipient.
   *
   * @param executionData
   */
  public onTransaction(executionData: BlockProverExecutionData): void {
    const feeConfig = Provable.witness(MethodFeeConfigData, () =>
      this.feeAnalyzer.getFeeConfig(
        executionData.transaction.methodId.toBigInt()
      )
    );

    const witness = Provable.witness(
      RuntimeFeeAnalyzerService.getWitnessType(),
      () =>
        this.feeAnalyzer.getWitness(
          executionData.transaction.methodId.toBigInt()
        )
    );

    const root = Field(this.feeAnalyzer.getRoot());
    const calculatedRoot = witness.calculateRoot(feeConfig.hash());

    root.assertEquals(calculatedRoot, errors.invalidFeeTreeRoot());
    feeConfig.methodId.assertEquals(
      executionData.transaction.methodId,
      errors.invalidFeeConfigMethodId()
    );

    const fee = O1JSUInt64.from(feeConfig.baseFee.value).add(
      O1JSUInt64.from(feeConfig.weight.value).mul(
        O1JSUInt64.from(feeConfig.perWeightUnitFee.value)
      )
    );

    this.transferFee(executionData.transaction.sender, new UInt64(fee.value));
  }
}
