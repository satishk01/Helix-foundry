import { it, expect, vi, afterEach } from "vitest";
import { Provider } from "../apps/api/src/providers.js";
import { ProviderSchema } from "../packages/shared/src/index.js";

// The Bedrock branch uses the SDK (SigV4) rather than fetch, so the SDK is
// mocked: the test checks the Converse request it builds and the answer it
// reads back.
const bedrock = vi.hoisted(() => ({
  sent: [] as any[],
  options: undefined as any,
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    constructor(options: any) {
      bedrock.options = options;
    }
    async send(command: any) {
      bedrock.sent.push(command.input);
      // InvokeModelCommand carries a JSON body (embeddings); Converse does not.
      if (command.input?.body)
        return {
          body: new TextEncoder().encode(
            JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
          ),
        };
      return {
        output: {
          message: {
            content: [
              { toolUse: { name: "submit", input: { ready: true } } },
            ],
          },
        },
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }
    destroy() {}
  },
  ConverseCommand: class {
    constructor(public input: any) {}
  },
  InvokeModelCommand: class {
    constructor(public input: any) {}
  },
}));

// AssumeRole goes through @aws-sdk/credential-providers; the mock records the
// parameters and returns a credential-provider function, like the real call.
const assumed = vi.hoisted(() => ({ args: undefined as any }));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromTemporaryCredentials: (args: any) => {
    assumed.args = args;
    return vi.fn();
  },
}));

const schema = {
  type: "object",
  properties: { ready: { type: "boolean" } },
  required: ["ready"],
  additionalProperties: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  bedrock.sent.length = 0;
  bedrock.options = undefined;
  assumed.args = undefined;
});

it("calls Azure OpenAI's v1 endpoint with the deployment and an api-key header", async () => {
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({
        output: [
          { content: [{ type: "output_text", text: '{"ready":true}' }] },
        ],
        usage: { total_tokens: 5 },
      });
    }),
  );
  const p = new Provider(
    ProviderSchema.parse({
      provider: "azure",
      model: "my-deployment",
      apiKey: "az-test-key",
      baseUrl: "https://res.openai.azure.com/",
    }),
  );
  const r = await p.generate("system", { safe: "profile" }, schema);
  expect(r).toEqual({ value: { ready: true }, tokens: 5 });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(
    "https://res.openai.azure.com/openai/v1/responses",
  );
  expect(requests[0].headers["api-key"]).toBe("az-test-key");
  expect(requests[0].body.model).toBe("my-deployment");
  expect(requests[0].body.text.format.strict).toBe(true);
});

it("requires an endpoint for Azure OpenAI", async () => {
  await expect(
    new Provider(
      ProviderSchema.parse({
        provider: "azure",
        model: "my-deployment",
        apiKey: "az-test-key",
      }),
    ).generate("", {}, schema),
  ).rejects.toThrow("Azure OpenAI endpoint is required");
});

it("sends a forced tool call through the Bedrock Converse API", async () => {
  const p = new Provider(
    ProviderSchema.parse({
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      apiKey: "AKIATEST:secret-test",
      region: "eu-west-1",
    }),
  );
  const r = await p.generate("system", { safe: "profile" }, schema);
  expect(r).toEqual({ value: { ready: true }, tokens: 5 });
  expect(bedrock.options.region).toBe("eu-west-1");
  expect(bedrock.options.credentials).toEqual({
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret-test",
  });
  expect(bedrock.sent).toHaveLength(1);
  const input = bedrock.sent[0];
  expect(input.modelId).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  expect(input.system).toEqual([{ text: "system" }]);
  expect(input.toolConfig.toolChoice).toEqual({ tool: { name: "submit" } });
  expect(input.toolConfig.tools[0].toolSpec.name).toBe("submit");
  expect(input.inferenceConfig.maxTokens).toBe(8192);
});

it("leaves Bedrock credentials to the AWS chain when no key is given", async () => {
  const p = new Provider(
    ProviderSchema.parse({ provider: "bedrock", model: "amazon.nova-pro-v1:0" }),
  );
  await p.generate("system", {}, schema);
  expect(bedrock.options.credentials).toBeUndefined();
  expect(bedrock.options.region).toBe("us-east-1");
});

it("rejects a malformed Bedrock key pair", async () => {
  await expect(
    new Provider(
      ProviderSchema.parse({
        provider: "bedrock",
        model: "test",
        apiKey: "no-separator",
      }),
    ).generate("", {}, schema),
  ).rejects.toThrow("ACCESS_KEY_ID:SECRET_ACCESS_KEY");
});

it("passes a session token for Bedrock temporary credentials", async () => {
  const p = new Provider(
    ProviderSchema.parse({
      provider: "bedrock",
      model: "amazon.nova-lite-v1:0",
      bedrockAuth: "session",
      apiKey: "ASIATEST:secret-test:token-test",
      region: "us-east-1",
    }),
  );
  await p.generate("system", {}, schema);
  expect(bedrock.options.credentials).toEqual({
    accessKeyId: "ASIATEST",
    secretAccessKey: "secret-test",
    sessionToken: "token-test",
  });
});

it("requires all three parts for Bedrock temporary credentials", async () => {
  await expect(
    new Provider(
      ProviderSchema.parse({
        provider: "bedrock",
        model: "test",
        bedrockAuth: "session",
        apiKey: "ASIATEST:secret-test",
      }),
    ).generate("", {}, schema),
  ).rejects.toThrow("SESSION_TOKEN");
});

it("requires a secret for Bedrock long-term keys", async () => {
  await expect(
    new Provider(
      ProviderSchema.parse({
        provider: "bedrock",
        model: "test",
        bedrockAuth: "accessKey",
        apiKey: "AKIAONLY",
      }),
    ).generate("", {}, schema),
  ).rejects.toThrow("ACCESS_KEY_ID:SECRET_ACCESS_KEY");
});

it("assumes the given IAM role for Bedrock", async () => {
  const p = new Provider(
    ProviderSchema.parse({
      provider: "bedrock",
      model: "amazon.nova-pro-v1:0",
      bedrockAuth: "role",
      roleArn: "arn:aws:iam::123456789012:role/FoundryBedrock",
      region: "eu-west-1",
    }),
  );
  await p.generate("system", {}, schema);
  expect(assumed.args.params).toEqual({
    RoleArn: "arn:aws:iam::123456789012:role/FoundryBedrock",
    RoleSessionName: "helix-foundry",
  });
  expect(assumed.args.clientConfig.region).toBe("eu-west-1");
  expect(typeof bedrock.options.credentials).toBe("function");
});

it("uses the AWS chain for Bedrock role mode without a role ARN", async () => {
  const p = new Provider(
    ProviderSchema.parse({
      provider: "bedrock",
      model: "amazon.nova-pro-v1:0",
      bedrockAuth: "role",
    }),
  );
  await p.generate("system", {}, schema);
  expect(assumed.args).toBeUndefined();
  expect(bedrock.options.credentials).toBeUndefined();
});

it("embeds through OpenAI's embeddings endpoint in index order", async () => {
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({
        data: [
          { index: 1, embedding: [0.3] },
          { index: 0, embedding: [0.9] },
        ],
      });
    }),
  );
  const p = new Provider(
    ProviderSchema.parse({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "sk-test",
    }),
  );
  const out = await p.embed(["alpha", "beta"]);
  expect(out).toEqual([[0.9], [0.3]]);
  expect(requests[0].url).toBe("https://api.openai.com/v1/embeddings");
  expect(requests[0].headers.authorization).toBe("Bearer sk-test");
  expect(requests[0].body).toEqual({
    model: "text-embedding-3-small",
    input: ["alpha", "beta"],
  });
});

it("requires an embeddings deployment for Azure semantic search", async () => {
  const p = new Provider(
    ProviderSchema.parse({
      provider: "azure",
      model: "my-deployment",
      apiKey: "az-test-key",
      baseUrl: "https://res.openai.azure.com/",
    }),
  );
  await expect(p.embed(["x"])).rejects.toThrow("embeddings deployment");
});

it("embeds through Azure using the embeddings deployment name", async () => {
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      requests.push({ url, headers: init.headers });
      return Response.json({ data: [{ index: 0, embedding: [0.5] }] });
    }),
  );
  const p = new Provider(
    ProviderSchema.parse({
      provider: "azure",
      model: "my-deployment",
      embedModel: "embed-deployment",
      apiKey: "az-test-key",
      baseUrl: "https://res.openai.azure.com/",
    }),
  );
  expect(await p.embed(["x"])).toEqual([[0.5]]);
  expect(requests[0].url).toBe(
    "https://res.openai.azure.com/openai/v1/embeddings",
  );
  expect(requests[0].headers["api-key"]).toBe("az-test-key");
});

it("rejects embeddings on Claude, which has no embeddings API", async () => {
  const p = new Provider(
    ProviderSchema.parse({
      provider: "claude",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant-test",
    }),
  );
  await expect(p.embed(["x"])).rejects.toThrow("no embeddings API");
});

it("embeds through Bedrock Titan via InvokeModel", async () => {
  const p = new Provider(
    ProviderSchema.parse({
      provider: "bedrock",
      model: "amazon.nova-pro-v1:0",
      apiKey: "AKIATEST:secret-test",
      region: "us-east-1",
    }),
  );
  const out = await p.embed(["alpha", "beta"]);
  expect(out).toEqual([
    [0.1, 0.2, 0.3],
    [0.1, 0.2, 0.3],
  ]);
  const calls = bedrock.sent.filter((i) => i.body);
  expect(calls).toHaveLength(2);
  expect(calls[0].modelId).toBe("amazon.titan-embed-text-v2:0");
  expect(JSON.parse(calls[0].body).inputText).toBe("alpha");
});
