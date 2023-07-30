import { FlexibleProvable } from "snarkyjs";
import { container } from "tsyringe";

import { ProvableMethodExecutionContext } from "./ProvableMethodExecutionContext";
import type { ZkProgrammable } from "./ZkProgrammable";

// eslint-disable-next-line etc/prefer-interface
export type DecoratedMethod = (...args: unknown[]) => unknown;

export const mockProof = "mock-proof";

export function toProver(
  methodName: string,
  simulatedMethod: DecoratedMethod,
  isFirstParameterPublicInput: boolean,
  ...args: unknown[]
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function prover(this: ZkProgrammable<any, any>) {
    const areProofsEnabled = this.appChain?.areProofsEnabled;
    if (areProofsEnabled ?? false) {
      const programProvableMethod = this.zkProgram.methods[methodName];
      return await Reflect.apply(programProvableMethod, this, args);
    }

    // create a mock proof by simulating method execution in JS
    const publicOutput = Reflect.apply(simulatedMethod, this, args);

    return new this.zkProgram.Proof({
      proof: mockProof,

      // eslint-disable-next-line no-warning-comments
      // TODO: provide undefined if public input is not used
      publicInput: isFirstParameterPublicInput ? args[0] : undefined,
      publicOutput,

      /**
       * We set this to the max possible number, to avoid having
       * to manually count in-circuit proof verifications
       */
      maxProofsVerified: 2,
    });
  };
}

/**
 * Decorates a provable method on a 'prover class', depending on
 * if proofs are enabled or not, either runs the respective zkProgram prover,
 * or simulates the method execution and issues a mock proof.
 *
 * @param isFirstParameterPublicInput
 * @param executionContext
 * @returns
 */
export function provableMethod(
  isFirstParameterPublicInput = true,
  executionContext: ProvableMethodExecutionContext = container.resolve<ProvableMethodExecutionContext>(
    ProvableMethodExecutionContext
  )
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <Target extends ZkProgrammable<any, any>>(
    target: Target,
    methodName: string,
    descriptor: PropertyDescriptor
  ) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const simulatedMethod = descriptor.value as DecoratedMethod;

    descriptor.value = function value(
      this: ZkProgrammable<unknown, unknown>,
      ...args: FlexibleProvable<unknown>[]
    ) {
      const prover = toProver(methodName, simulatedMethod, isFirstParameterPublicInput, ...args);

      executionContext.beforeMethod(this.constructor.name, methodName, args);

      /**
       * Check if the method is called at the top level,
       * if yes then create a prover.
       */
      if (executionContext.isTopLevel) {
        executionContext.setProver(prover.bind(this));
      }

      /**
       * Regardless of if the method is called from the top level
       * or not, execute its simulated (Javascript) version and
       * return the result.
       */
      // eslint-disable-next-line @typescript-eslint/init-declarations
      let result: unknown;
      try {
        result = Reflect.apply(simulatedMethod, this, args);
      } finally {
        executionContext.afterMethod();
      }

      return result;
    };

    return descriptor;
  };
}
