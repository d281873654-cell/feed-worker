import {
  env,
  SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const ROOT_RESPONSE =
  "feed-worker 运行中。手动触发：GET /sync + x-api-key / Authorization: Bearer";

describe("feed-worker", () => {
  it("returns the worker status from the fetch handler", async () => {
    const request = new IncomingRequest("http://example.com");

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ROOT_RESPONSE);
  });

  it("returns the worker status through the integration runtime", async () => {
    const response = await SELF.fetch("https://example.com");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ROOT_RESPONSE);
  });
});