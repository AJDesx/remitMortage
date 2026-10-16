# Frontend and backend API contracts

The consumer catalog at `contracts/api/frontend-consumer.json` records the frontend operations and response codes relied on by the UI. Mock examples live in `frontend/__tests__/fixtures/frontend-api-contract-mocks.json`; CI verifies both against the backend's generated OpenAPI document.

When changing an endpoint, first update its OpenAPI annotations in the backend route. Preserve existing response codes and payload fields when possible. For an intentional breaking change, update the consumer entry and mock fixture in the same pull request, and update the frontend caller and its tests. A backend-only change that removes a declared path, method, or response code fails CI.

CI exports OpenAPI from backend source and runs `node scripts/verify-frontend-api-contracts.mjs`. The generated `backend/openapi.json` is a build artifact; the versioned consumer catalog and mock examples are the reviewed contract artifacts.
