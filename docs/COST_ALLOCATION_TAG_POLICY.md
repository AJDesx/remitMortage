# Cloud Cost Allocation Tag Policy

Untagged resources cannot be attributed to a service or owner. Every taggable
AWS resource must carry:

| Tag | Meaning | Source |
| --- | --- | --- |
| `Service` | Workload the resource belongs to (`backend`, `indexer`, `observability-elk`, …) | constant in each module's `local.required_tags` |
| `Environment` | `dev` / `staging` / `production` | `var.environment` |
| `Owner` | Accountable team | `var.owner` (default `platform-team`) |
| `CostCenter` | Where spend is booked | `var.cost_center` (default `remitmortgage-core`) |

## How it is enforced

1. **Terraform default tags.** Every `provider "aws"` block (including aliases)
   sets `default_tags { tags = local.required_tags }`, so resources inherit the
   set without repeating it. `scripts/check-terraform-default-tags.mjs` fails CI
   if a provider block omits it.
2. **Plan policy.** `devops/policy/tags/tags.rego` (OPA / conftest) inspects
   `terraform show -json`: every resource a plan **creates or updates** must have
   all four keys, non-empty, in `tags_all` (resource tags merged with default
   tags). Missing keys fail the plan, with the resource address and the tags that
   are absent. If `tags_all` is only known after apply the policy warns instead.
3. **CI** (`.github/workflows/tag-policy.yml`): policy unit tests and fixtures on
   every relevant PR; a real `terraform plan` + `conftest` per module for
   same-repo PRs.
4. **Scheduled report** (Mondays 06:00 UTC): `scripts/report-untagged-resources.mjs`
   lists existing resources missing any required tag, as a run summary and as the
   `untagged-resources` artifact (markdown + JSON).

## Running locally

```bash
devops/policy/tags/run-tests.sh                      # needs opa + conftest
node --test scripts/check-terraform-default-tags.test.mjs scripts/report-untagged-resources.test.mjs

terraform -chdir=devops plan -out=tfplan && terraform -chdir=devops show -json tfplan > plan.json
conftest test --policy devops/policy/tags --namespace terraform.tags plan.json
node scripts/report-untagged-resources.mjs --region us-east-1
```

Policy tests cover compliant and non-compliant plans: `tags_test.rego` (unit) and
`fixtures/compliant-plan.json` / `fixtures/non-compliant-plan.json` (end to end
through conftest).

## Exemptions and limits

- Types with no cost of their own can be listed in `exempt_types` in `tags.rego`.
- Resources that don't support tags (and `delete` / `no-op` plan entries) are ignored.
- The report uses the Resource Groups Tagging API, which does not list every
  resource type that has *never* been tagged; AWS Config is the complete source
  if gaps matter.
- Existing resources only receive default tags on their next apply.
