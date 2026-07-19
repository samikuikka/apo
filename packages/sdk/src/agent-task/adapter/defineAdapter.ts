import type {
  DeliverableDefinition,
  TypedAdapterDefinition,
} from "./types.ts";

export function defineAdapter<
  const TName extends string,
  const TDeliverables extends Record<string, DeliverableDefinition>,
>(
  adapter: TypedAdapterDefinition<TName, TDeliverables>,
): TypedAdapterDefinition<TName, TDeliverables> {
  return adapter;
}
