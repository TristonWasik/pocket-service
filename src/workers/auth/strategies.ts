import { Request } from "express";
import { createRemoteJWKSet, JWTPayload, jwtVerify } from "jose";
import { PeerCertificate, TLSSocket } from "tls";
import {
  AuthenticatedUser,
  AuthStrategy,
  RouteDefinition,
} from "../express-types";

type JwtClaimValue = string | string[] | number | boolean | null | undefined;

export type JwtStrategyClaims = {
  sub?: string;
  [key: string]: unknown;
};

export type JwtTokenVerifier = (
  token: string,
  req: Request,
  route: RouteDefinition<any, any, boolean>,
) => JwtStrategyClaims | null | Promise<JwtStrategyClaims | null>;

export type CreateJwtAuthStrategyOptions = {
  name?: string;
  headerName?: string;
  tokenPrefix?: string;
  verifyToken: JwtTokenVerifier;
  mapPayloadToUser?: (
    claims: JwtStrategyClaims,
    req: Request,
    route: RouteDefinition<any, any, boolean>,
  ) => AuthenticatedUser | null | Promise<AuthenticatedUser | null>;
  canHandle?: AuthStrategy["canHandle"];
};

export type CreateJoseJwtVerifierOptions = {
  jwksUri?: string;
  secret?: string | Uint8Array;
  issuer?: string | string[];
  audience?: string | string[];
  algorithms?: string[];
  clockTolerance?: string | number;
  requiredClaims?: string[];
};

export type CreateMtlsAuthStrategyOptions = {
  name?: string;
  requireAuthorized?: boolean;
  mapCertificateToUser?: (
    certificate: PeerCertificate,
    req: Request,
    route: RouteDefinition<any, any, boolean>,
  ) => AuthenticatedUser | null | Promise<AuthenticatedUser | null>;
  canHandle?: AuthStrategy["canHandle"];
};

function readAuthTokenFromHeader(
  req: Request,
  headerName: string,
  tokenPrefix: string,
): string | null {
  const header = req.headers[headerName.toLowerCase()];

  if (typeof header !== "string") {
    return null;
  }

  const value = header.trim();
  if (!value) {
    return null;
  }

  if (!tokenPrefix) {
    return value;
  }

  const prefix = `${tokenPrefix} `;
  if (!value.startsWith(prefix)) {
    return null;
  }

  return value.slice(prefix.length).trim() || null;
}

function isUserValue(
  value: unknown,
): value is Exclude<JwtClaimValue, null | undefined> {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((v) => typeof v === "string"))
  );
}

function claimsToAuthenticatedUser(
  claims: JwtStrategyClaims,
): AuthenticatedUser | null {
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return null;
  }

  const user: AuthenticatedUser = { userId: claims.sub };
  for (const [key, value] of Object.entries(claims)) {
    if (key === "sub") {
      continue;
    }

    if (isUserValue(value)) {
      user[key] = value;
    }
  }

  return user;
}

function jwtPayloadToStrategyClaims(payload: JWTPayload): JwtStrategyClaims {
  const claims: JwtStrategyClaims = {};

  for (const [key, value] of Object.entries(payload)) {
    claims[key] = value;
  }

  if (typeof payload.sub === "string") {
    claims.sub = payload.sub;
  }

  return claims;
}

function hasRequiredClaims(payload: JWTPayload, requiredClaims: string[]) {
  return requiredClaims.every((claim) => payload[claim] !== undefined);
}

export function createJoseJwtVerifier(
  options: CreateJoseJwtVerifierOptions,
): JwtTokenVerifier {
  const requiredClaims = options.requiredClaims ?? ["sub"];
  const jwtVerifyOptions = {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: options.algorithms,
    clockTolerance: options.clockTolerance,
  };

  if (options.jwksUri) {
    const jwksKeySource = createRemoteJWKSet(new URL(options.jwksUri));

    return async (token) => {
      try {
        const { payload } = await jwtVerify(
          token,
          jwksKeySource,
          jwtVerifyOptions,
        );

        if (!hasRequiredClaims(payload, requiredClaims)) {
          return null;
        }

        return jwtPayloadToStrategyClaims(payload);
      } catch {
        return null;
      }
    };
  }

  const secretKey =
    typeof options.secret === "string"
      ? new TextEncoder().encode(options.secret)
      : options.secret;

  if (!(secretKey instanceof Uint8Array)) {
    throw new Error("createJoseJwtVerifier requires either jwksUri or secret.");
  }

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, secretKey, jwtVerifyOptions);

      if (!hasRequiredClaims(payload, requiredClaims)) {
        return null;
      }

      return jwtPayloadToStrategyClaims(payload);
    } catch {
      return null;
    }
  };
}

function parseSubjectAltNames(subjectAltName?: string): string[] {
  if (!subjectAltName) {
    return [];
  }

  return subjectAltName
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveMtlsIdentity(certificate: PeerCertificate): string | null {
  const sans = parseSubjectAltNames(certificate.subjectaltname);
  const uriSan = sans.find((value) => value.startsWith("URI:"));
  if (uriSan) {
    return uriSan.slice(4).trim() || null;
  }

  const dnsSan = sans.find((value) => value.startsWith("DNS:"));
  if (dnsSan) {
    return dnsSan.slice(4).trim() || null;
  }

  const subjectCn = certificate.subject?.CN;
  if (typeof subjectCn === "string" && subjectCn.length > 0) {
    return subjectCn;
  }
  if (Array.isArray(subjectCn) && subjectCn.length > 0) {
    const first = subjectCn[0];
    if (typeof first === "string" && first.length > 0) {
      return first;
    }
  }

  if (certificate.fingerprint256) {
    return certificate.fingerprint256;
  }

  return null;
}

export function createJwtAuthStrategy(
  options: CreateJwtAuthStrategyOptions,
): AuthStrategy {
  const headerName = options.headerName ?? "authorization";
  const tokenPrefix = options.tokenPrefix ?? "Bearer";

  return {
    name: options.name ?? "jwt",
    canHandle: options.canHandle,
    authenticate: async (req, route) => {
      const token = readAuthTokenFromHeader(req, headerName, tokenPrefix);
      if (!token) {
        return null;
      }

      const claims = await options.verifyToken(token, req, route);
      if (!claims) {
        return null;
      }

      if (options.mapPayloadToUser) {
        return options.mapPayloadToUser(claims, req, route);
      }

      return claimsToAuthenticatedUser(claims);
    },
  };
}

export function createMtlsAuthStrategy(
  options: CreateMtlsAuthStrategyOptions = {},
): AuthStrategy {
  const requireAuthorized = options.requireAuthorized ?? true;

  return {
    name: options.name ?? "mtls",
    canHandle: options.canHandle,
    authenticate: async (req, route) => {
      const socket = req.socket as TLSSocket;
      if (typeof socket.getPeerCertificate !== "function") {
        return null;
      }

      if (requireAuthorized && socket.authorized !== true) {
        return null;
      }

      const certificate = socket.getPeerCertificate(true);
      if (!certificate || Object.keys(certificate).length === 0) {
        return null;
      }

      if (options.mapCertificateToUser) {
        return options.mapCertificateToUser(certificate, req, route);
      }

      const userId = resolveMtlsIdentity(certificate);
      if (!userId) {
        return null;
      }

      return {
        userId,
        certSubjectCn: certificate.subject?.CN ?? "",
        certIssuerCn: certificate.issuer?.CN ?? "",
        certFingerprint256: certificate.fingerprint256 ?? "",
        certSerialNumber: certificate.serialNumber ?? "",
        mtlsAuthorized: socket.authorized,
      };
    },
  };
}
