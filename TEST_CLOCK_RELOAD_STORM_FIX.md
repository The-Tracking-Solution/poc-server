# Test clock / 5s reload storm fix

- `run_test_clock.py` is idempotent: existing profile-channel relations and unchanged RadioUser fields are not saved again on service restart.
- This prevents repeated `config_changed` broadcasts caused solely by test-clock restarts.
- `tenant_actions.js` no longer hard reloads the page for `contacts`; only `screens` and `hardware` changes can trigger a full reload.
- Contacts/identity/profile changes use the existing runtime bootstrap refresh instead.
