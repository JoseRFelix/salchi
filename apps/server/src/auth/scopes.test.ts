import {
  AuthAdministrativeScopes,
  AuthBrowserOperateScope,
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  EnvironmentAuthorizationError,
} from "@salchi/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { requireAuthScope } from "./scopes.ts";

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

it.effect("owner scopes imply browser:operate", () =>
  requireAuthScope(AuthAdministrativeScopes, AuthBrowserOperateScope),
);

it("standard client scopes do not imply browser:operate", () => {
  const standardClientScopes: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes;
  assert.isFalse(standardClientScopes.includes(AuthBrowserOperateScope));
});

it.effect("browser operations reject standard client scopes", () =>
  Effect.gen(function* () {
    const exit = yield* requireAuthScope(AuthStandardClientScopes, AuthBrowserOperateScope).pipe(
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isSuccess(exit)) return;
    const error = yield* Effect.flip(Effect.failCause(exit.cause));
    assert.isTrue(isEnvironmentAuthorizationError(error));
    if (isEnvironmentAuthorizationError(error)) {
      assert.equal(error.requiredScope, AuthBrowserOperateScope);
    }
  }),
);
