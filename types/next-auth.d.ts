// Roles are deliberately absent from the session and the JWT: lib/authz
// resolves them per request through lib/roles, so a role change takes effect
// immediately instead of when an 8-hour token expires.
export {};
