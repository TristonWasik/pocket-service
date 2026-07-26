/// <reference types="vitest/globals" />
import type { Request } from "express";
import { SignJWT } from "jose";
import {
  createJoseJwtVerifier,
  createJwtAuthStrategy,
  createMtlsAuthStrategy,
} from "../../src/auth/strategies";
import type { RouteDefinition } from "../../src/api/express-types";

const route: RouteDefinition<any, any, boolean> = {
  method: "GET",
  fullPath: "/secure",
  requireAuth: true,
};

describe("Auth strategies", () => {
  it("maps JWT claims to authenticated user using Bearer token", async () => {
    const strategy = createJwtAuthStrategy({
      verifyToken: async () => ({
        sub: "user-1",
        team: "core",
        flags: ["a", "b"],
        ignoredObject: { x: 1 },
      }),
    });

    const req = {
      headers: { authorization: "Bearer signed-token" },
    } as unknown as Request;

    await expect(strategy.authenticate(req, route)).resolves.toEqual({
      userId: "user-1",
      team: "core",
      flags: ["a", "b"],
    });
  });

  it("returns null when token prefix does not match", async () => {
    const verifyToken = vi.fn();
    const strategy = createJwtAuthStrategy({
      verifyToken,
    });

    const req = {
      headers: { authorization: "Token signed-token" },
    } as unknown as Request;

    await expect(strategy.authenticate(req, route)).resolves.toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("supports custom payload mapping", async () => {
    const strategy = createJwtAuthStrategy({
      verifyToken: async () => ({ sub: "user-2", role: "admin" }),
      mapPayloadToUser: async (claims) => ({
        userId: String(claims.sub),
        role: String(claims.role),
      }),
    });

    const req = {
      headers: { authorization: "Bearer signed-token" },
    } as unknown as Request;

    await expect(strategy.authenticate(req, route)).resolves.toEqual({
      userId: "user-2",
      role: "admin",
    });
  });

  it("verifies HS256 JWT using jose verifier", async () => {
    const secret = "test-secret";
    const token = await new SignJWT({ scope: "api:read" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("subject-1")
      .setIssuer("issuer-a")
      .setAudience("audience-a")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(secret));

    const verify = createJoseJwtVerifier({
      secret,
      issuer: "issuer-a",
      audience: "audience-a",
      requiredClaims: ["sub", "scope"],
    });

    await expect(verify(token, {} as Request, route)).resolves.toMatchObject({
      sub: "subject-1",
      scope: "api:read",
    });
  });

  it("returns null when required JWT claims are missing", async () => {
    const secret = "test-secret";
    const token = await new SignJWT({ role: "reader" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("subject-2")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(secret));

    const verify = createJoseJwtVerifier({
      secret,
      requiredClaims: ["sub", "scope"],
    });

    await expect(verify(token, {} as Request, route)).resolves.toBeNull();
  });

  it("extracts mTLS identity from URI SAN", async () => {
    const strategy = createMtlsAuthStrategy();
    const req = {
      socket: {
        authorized: true,
        getPeerCertificate: () => ({
          subjectaltname:
            "DNS:service.local, URI:spiffe://cluster/ns/default/sa/api",
          subject: { CN: "subject-cn" },
          issuer: { CN: "issuer-cn" },
          fingerprint256: "fingerprint",
          serialNumber: "serial",
        }),
      },
    } as unknown as Request;

    await expect(strategy.authenticate(req, route)).resolves.toMatchObject({
      userId: "spiffe://cluster/ns/default/sa/api",
      certSubjectCn: "subject-cn",
      certIssuerCn: "issuer-cn",
      certFingerprint256: "fingerprint",
      certSerialNumber: "serial",
      mtlsAuthorized: true,
    });
  });

  it("rejects unauthorized mTLS request by default", async () => {
    const strategy = createMtlsAuthStrategy();
    const req = {
      socket: {
        authorized: false,
        getPeerCertificate: () => ({ subject: { CN: "x" } }),
      },
    } as unknown as Request;

    await expect(strategy.authenticate(req, route)).resolves.toBeNull();
  });
});
