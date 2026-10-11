import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

/**
 * 开源构建没有闭源 ClientRequestSigningV4：ultra 网关（zcode.z.ai/api/v1/ultra-*）
 * 只接受带客户端签名的传输格式，未签名请求一律 401 "Invalid Authentication Token"。
 * 因此本 edition 不做网关重写，账号套餐流量直连 api.z.ai / open.bigmodel.cn，
 * 以短期 Project Token 作为 Bearer（官方对第三方客户端开放的调用方式）。
 */
export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl) {
      return { routed: false, url: requestUrl };
    },
  };
}
