import { describe, expect, it } from "vitest";
import { insecureSslReason, sslConfig } from "@/scripts/ssl-config.mjs";

const remote = "postgres://u:p@ep-cool-name-pooler.us-east-2.aws.neon.tech/atlas";

describe("database TLS", () => {
  it("verifies certificates for a remote database by default", () => {
    expect(sslConfig(remote, {})).toEqual({ rejectUnauthorized: true });
  });

  it("uses a private CA when one is given", () => {
    expect(sslConfig(remote, { DATABASE_CA_CERT: "PEM" })).toEqual({ rejectUnauthorized: true, ca: "PEM" });
  });

  it("leaves TLS to the URL when it names an sslmode", () => {
    expect(sslConfig(`${remote}?sslmode=verify-full`, {})).toBeUndefined();
  });

  it("does not use TLS for a local database", () => {
    expect(sslConfig("postgres://atlas:atlas@localhost:5432/atlas", {})).toBe(false);
  });

  it("accepts verify-full and a bare remote URL", () => {
    expect(insecureSslReason(remote, {})).toBeNull();
    expect(insecureSslReason(`${remote}?sslmode=verify-full`, {})).toBeNull();
  });

  it("rejects settings that skip encryption or verification", () => {
    expect(insecureSslReason(`${remote}?sslmode=disable`, {})).toMatch(/sslmode=disable/);
    expect(insecureSslReason(`${remote}?sslmode=no-verify`, {})).toMatch(/sslmode=no-verify/);
    expect(insecureSslReason(`${remote}?sslmode=require&uselibpqcompat=true`, {})).toMatch(/uselibpqcompat/);
    expect(insecureSslReason(remote, { DATABASE_SSL: "disable" })).toMatch(/DATABASE_SSL/);
  });

  it("allows anything against a local database", () => {
    expect(insecureSslReason("postgres://localhost/atlas?sslmode=disable", {})).toBeNull();
  });
});
