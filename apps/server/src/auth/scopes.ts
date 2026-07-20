import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
} from "@salchi/contracts";

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
