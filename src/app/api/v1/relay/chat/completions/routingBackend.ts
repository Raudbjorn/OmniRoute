export {
  getBifrostRoutingConfig,
  resolveRelayRoutingBackend,
  shouldTryBifrostForRequest,
  getRoutingFallbackHeader,
  getRoutingFallbackReasonHeader,
  type BifrostRoutingConfig,
} from "@/shared/services/bifrost/bifrostRouting";

export type {
  RelayRoutingBackend,
  SidecarEligibility,
  ProviderSidecarLookup,
  BifrostRoutingDecision,
  RoutingFallbackReasonCode,
} from "@/shared/services/bifrost/bifrostRouting";
export { shouldTryBifrost } from "@/shared/services/bifrost/bifrostRouting";
