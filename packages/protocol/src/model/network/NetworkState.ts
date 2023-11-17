import { Field, Poseidon, Struct, UInt64 } from "o1js";

export class CurrentBlock extends Struct({
  height: UInt64,
}) {}

export class PreviousBlock extends Struct({
  rootHash: Field,
}) {}

export class NetworkState extends Struct({
  block: CurrentBlock,
  previous: PreviousBlock,
}) {
  public hash(): Field {
    return Poseidon.hash([
      ...CurrentBlock.toFields(this.block),
      ...PreviousBlock.toFields(this.previous),
    ]);
  }
}
