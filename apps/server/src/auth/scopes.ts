import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  EnvironmentAuthorizationError,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";

import type { SessionRole } from "./Services/SessionCredentialService.ts";

export function scopesForSessionRole(role: SessionRole): ReadonlyArray<AuthEnvironmentScope> {
  return role === "owner" ? AuthAdministrativeScopes : AuthStandardClientScopes;
}

export function hasAuthScope(
  scopes: ReadonlySet<AuthEnvironmentScope> | ReadonlyArray<AuthEnvironmentScope>,
  requiredScope: AuthEnvironmentScope,
): boolean {
  return scopes instanceof Set
    ? scopes.has(requiredScope)
    : Array.from(scopes).includes(requiredScope);
}

export function requireAuthScope(
  scopes: ReadonlySet<AuthEnvironmentScope> | ReadonlyArray<AuthEnvironmentScope>,
  requiredScope: AuthEnvironmentScope,
): Effect.Effect<void, EnvironmentAuthorizationError> {
  return hasAuthScope(scopes, requiredScope)
    ? Effect.void
    : Effect.fail(
        new EnvironmentAuthorizationError({
          message: `The authenticated session requires the ${requiredScope} scope.`,
          requiredScope,
        }),
      );
}
