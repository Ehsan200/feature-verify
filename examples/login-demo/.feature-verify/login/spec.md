# Login

Users sign in with email and password.

## Acceptance criteria
- Valid credentials return a session token and the user.
- A wrong password returns 401.
- After 5 failed attempts the account is locked and login returns 423.
