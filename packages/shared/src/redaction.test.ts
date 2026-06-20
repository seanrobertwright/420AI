import { describe, it, expect } from "vitest";
import { redact, redactJson, REDACTION_VERSION, type RedactionFinding } from "./redaction.js";

/** Helper: the finding for a given kind, or undefined. */
function find(findings: RedactionFinding[], kind: string): RedactionFinding | undefined {
  return findings.find((f) => f.kind === kind);
}

describe("redact — known-pattern rules", () => {
  it("masks an Anthropic key and records a finding with NO raw value", () => {
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
    const { redacted, findings } = redact(`my key is ${secret} ok`);
    expect(redacted).toBe("my key is [REDACTED:anthropic_key] ok");
    const f = find(findings, "anthropic_key");
    expect(f).toMatchObject({ kind: "anthropic_key", count: 1, placeholder: "[REDACTED:anthropic_key]" });
    // The raw secret must not survive anywhere — neither in the text nor the metadata.
    expect(redacted).not.toContain(secret);
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(JSON.stringify(findings)).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
  });

  it("masks an OpenAI-style key (and does not double-claim the anthropic one)", () => {
    const { redacted, findings } = redact("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234");
    expect(redacted).toBe("[REDACTED:openai_key]");
    expect(find(findings, "openai_key")?.count).toBe(1);
    expect(find(findings, "anthropic_key")).toBeUndefined();
  });

  it("masks an AWS access key id", () => {
    const { redacted } = redact("AKIAIOSFODNN7EXAMPLE here");
    expect(redacted).toBe("[REDACTED:aws_access_key] here");
  });

  it("masks a GitHub token", () => {
    const tok = "ghp_" + "a".repeat(36);
    const { redacted } = redact(tok);
    expect(redacted).toBe("[REDACTED:github_token]");
  });

  it("masks a Google API key", () => {
    const key = "AIza" + "B".repeat(35);
    expect(redact(key).redacted).toBe("[REDACTED:google_api_key]");
  });

  it("masks a Slack token", () => {
    const { redacted } = redact("xoxb-0123456789-abcdefghij");
    expect(redacted).toBe("[REDACTED:slack_token]");
  });

  it("masks a JWT", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4";
    expect(redact(jwt).redacted).toBe("[REDACTED:jwt]");
  });

  it("masks a PEM private key block (multiline, lazy)", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...lines...\nQ==\n-----END RSA PRIVATE KEY-----";
    const { redacted, findings } = redact(`before\n${pem}\nafter`);
    expect(redacted).toBe("before\n[REDACTED:private_key_block]\nafter");
    expect(find(findings, "private_key_block")?.count).toBe(1);
  });

  it("masks a connection string's credentialed authority only", () => {
    const { redacted } = redact("postgres://user:hunter2@db.example.com:5432/app");
    expect(redacted).toContain("[REDACTED:connection_string]");
    expect(redacted).not.toContain("hunter2");
    // host/db structure after the @ is preserved (it carried no @ to re-match).
    expect(redacted).toContain("db.example.com:5432/app");
  });

  it("masks an authorization/bearer assignment", () => {
    const { redacted } = redact("authorization=sometoken12345");
    expect(redacted).toBe("[REDACTED:bearer_auth]");
  });

  it("masks the full token in header-style 'Authorization: ******'", () => {
    const token = "eyJsomeLongTokenValue12345";
    const { redacted } = redact("Authorization: Bearer " + token);
    expect(redacted).toBe("[REDACTED:bearer_auth]");
    expect(redacted).not.toContain(token);
  });

  it("masks a generic secret assignment", () => {
    const { redacted } = redact("password: hunter2longpass");
    expect(redacted).toContain("[REDACTED:generic_secret_assignment]");
    expect(redacted).not.toContain("hunter2longpass");
  });

  it("masks an email address", () => {
    const { redacted } = redact("contact me at jane.doe@example.com please");
    expect(redacted).toBe("contact me at [REDACTED:email] please");
  });

  it("home_user_path masks ONLY the username segment (posix and windows)", () => {
    expect(redact("/home/alice/project/x").redacted).toBe(
      "/home/[REDACTED:home_user_path]/project/x",
    );
    expect(redact("/Users/bob/code").redacted).toBe("/Users/[REDACTED:home_user_path]/code");
    expect(redact("C:\\Users\\carol\\repo").redacted).toBe(
      "C:\\Users\\[REDACTED:home_user_path]\\repo",
    );
  });

  it("masks a JSON-escaped Windows home path (verbatim JSONL: double backslash)", () => {
    // As stored in a raw record: `{"cwd":"C:\\Users\\sean\\app"}` has TWO backslash
    // chars per separator. The username must still be masked.
    const line = '{"cwd":"C:\\\\Users\\\\sean\\\\app"}';
    const { redacted, findings } = redact(line);
    expect(redacted).toBe('{"cwd":"C:\\\\Users\\\\[REDACTED:home_user_path]\\\\app"}');
    expect(redacted).not.toContain("sean");
    expect(find(findings, "home_user_path")?.count).toBe(1);
  });
});

describe("redact — benign near-misses are NOT over-masked", () => {
  it("does not mask a plain file path without a home username", () => {
    const text = "/usr/local/bin/node and /var/log/app.log";
    expect(redact(text).redacted).toBe(text);
  });

  it("does not mask ordinary prose / short words", () => {
    const text = "the bearer of good news visited the secret garden today";
    // No `[:=]` after bearer/secret, no long high-entropy token → untouched.
    expect(redact(text).redacted).toBe(text);
  });

  it("does not mask a short alphanumeric token under the entropy length floor", () => {
    expect(redact("abc123 def456").redacted).toBe("abc123 def456");
  });
});

describe("redact — high-entropy backstop", () => {
  it("masks a long mixed random token", () => {
    const token = "Z9x2Qw7Lp4Rt8Vn3Bm6Kc1Df5Gh0Js7Aa2Bb4Cc"; // 40 chars, digits + letters
    const { redacted, findings } = redact(`token ${token} end`);
    expect(redacted).toBe("token [REDACTED:high_entropy] end");
    expect(find(findings, "high_entropy")?.count).toBe(1);
  });

  it("does NOT mask a long all-letter prose word (no digits)", () => {
    const word = "supercalifragilisticexpialidocious"; // 34 letters, no digit
    expect(redact(word).redacted).toBe(word);
  });
});

describe("redact — invariants", () => {
  it("is idempotent: re-running on the output finds nothing new", () => {
    const input =
      "key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV0123 at /home/alice/x mail a@b.com tok Z9x2Qw7Lp4Rt8Vn3Bm6Kc1Df5Gh0Js7";
    const first = redact(input);
    const second = redact(first.redacted);
    expect(second.findings).toEqual([]);
    expect(second.redacted).toBe(first.redacted);
  });

  it("counts repeated secrets correctly", () => {
    const s = "a@b.com and c@d.org and e@f.net";
    expect(find(redact(s).findings, "email")?.count).toBe(3);
  });

  it("empty / whitespace input returns no findings", () => {
    expect(redact("")).toEqual({ redacted: "", findings: [] });
    expect(redact("   \n\t ").findings).toEqual([]);
  });

  it("exports a stable REDACTION_VERSION", () => {
    expect(REDACTION_VERSION).toBe("m8-redact-v1");
  });
});

describe("redactJson — the deep §18 export gate", () => {
  const SECRET = "sk-ant-api03-DEEPNESTEDSECRETKEY0123456789";

  it("masks secrets/paths/keys in nested strings while preserving structure and non-strings", () => {
    const input = {
      a: `use ${SECRET} please`,
      b: { path: "C:\\Users\\alice\\x" },
      n: 42,
      flag: true,
      nil: null,
      list: ["plain", "AKIAIOSFODNN7EXAMPLE"],
    };
    const { value, findings } = redactJson(input);

    // Structure + non-string values preserved.
    expect(value.n).toBe(42);
    expect(value.flag).toBe(true);
    expect(value.nil).toBeNull();
    expect(value.list[0]).toBe("plain");
    expect(Object.keys(value)).toEqual(["a", "b", "n", "flag", "nil", "list"]);

    // Strings masked.
    expect(value.a).toContain("[REDACTED:anthropic_key]");
    expect(value.a).not.toContain(SECRET);
    expect(value.b.path).toBe("C:\\Users\\[REDACTED:home_user_path]\\x");
    expect(value.list[1]).toBe("[REDACTED:aws_access_key]");

    // Findings merged per kind; NO finding carries a raw secret.
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("anthropic_key");
    expect(kinds).toContain("home_user_path");
    expect(kinds).toContain("aws_access_key");
    expect(JSON.stringify(findings)).not.toContain(SECRET);
    expect(JSON.stringify(findings)).not.toContain("alice");
  });

  it("does NOT mutate the input and does NOT redact object keys", () => {
    const input = { secret: `sk-ant-api03-KEEPKEYNAMEINTACT0123456789` };
    const { value } = redactJson(input);
    // The KEY "secret" is a field name, untouched.
    expect(Object.keys(value)).toEqual(["secret"]);
    // The original object is not mutated.
    expect(input.secret).toContain("sk-ant-");
  });

  it("merges repeated findings across the tree with summed counts", () => {
    const input = { x: "a@b.com", y: { z: "c@d.org" }, w: ["e@f.net"] };
    const { findings } = redactJson(input);
    const email = findings.find((f) => f.kind === "email");
    expect(email?.count).toBe(3);
  });

  it("is idempotent: re-running adds no new findings and changes nothing", () => {
    const input = {
      a: `key ${SECRET} at /home/alice/x`,
      b: ["mail a@b.com", { tok: "Z9x2Qw7Lp4Rt8Vn3Bm6Kc1Df5Gh0Js7" }],
      n: 7,
    };
    const first = redactJson(input);
    const second = redactJson(first.value);
    expect(second.findings).toEqual([]);
    expect(second.value).toEqual(first.value);
  });

  it("passes a bare primitive through redact unchanged when benign", () => {
    expect(redactJson(42).value).toBe(42);
    expect(redactJson(true).value).toBe(true);
    expect(redactJson(null).value).toBeNull();
    expect(redactJson("plain text").value).toBe("plain text");
  });
});
