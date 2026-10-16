# Terraform Plan Summary on Pull Requests

Reviewers should not need to read raw Terraform diffs or run `terraform plan`
locally to understand the impact of an infrastructure change. The
`Terraform Plan Comment` workflow
([`.github/workflows/terraform-plan-comment.yml`](../.github/workflows/terraform-plan-comment.yml))
plans the affected modules and posts **one** summary comment on the PR. The
same comment is updated in place on every push (it is identified by the hidden
marker `<!-- terraform-plan-summary-bot -->`).

## What the comment contains

1. **Banner** — failed modules, destructive-change count and security-sensitive
   change count across all modules.
2. **Per module** — totals (`N to add, N to change, N to destroy, N to replace`).
3. **⚠️ Destructive changes** — every `destroy` and `replace` (with Terraform's
   replacement reason, e.g. "replace because cannot update"), listed first.
4. **🔐 Security-sensitive changes** — IAM, security groups / NACLs / routing /
   VPC, WAF, Secrets Manager, SSM parameters, KMS, ACM, S3 bucket policy and
   public-access settings, load balancer listeners, CloudFront and RDS.
   The list lives in `SECURITY_SENSITIVE_PATTERNS` in
   [`scripts/terraform-plan-summary.mjs`](../scripts/terraform-plan-summary.mjs).
5. **Other changes** — collapsed in a `<details>` block.

## What it never contains

- Attribute **values**. Only resource addresses, types, action kinds and the
  *names* of changed attributes are shown; attributes Terraform marks sensitive
  are tagged `(sensitive)`.
- Credential-looking text. Plan error logs are scrubbed (AWS keys, GitHub
  tokens, bearer tokens, private keys, `password=…`-style pairs, long
  base64-like strings) before they are posted.

## Fork and untrusted contexts

The workflow runs on `pull_request` (never `pull_request_target`) and its job is
skipped unless `head.repo.full_name == github.repository`. Fork PRs therefore
get no cloud credentials and no plan output is posted for them.

## When planning fails

The module's section shows `❌ plan failed` with the last 40 scrubbed log lines,
the banner reports how many modules failed, the full log is uploaded as the
`terraform-plan-logs` artifact (7 days), and the job fails so the PR cannot be
merged with an unplannable change.

## Modules covered

| Module | State key | Notes |
|---|---|---|
| `devops` | `remitmortgage/staging/terraform.tfstate` | planned with `environment=staging` |
| `devops/terraform` | `remitmortgage/multi-region/terraform.tfstate` | multi-region failover |

A module is planned only when a `.tf` file directly inside its directory changed.
Plans use `-lock=false` so a PR plan can never block a real apply. To add a
module, add a `plan_module` line to the workflow and extend its `paths` filter.

## Tests

The formatter is a pure function over `terraform show -json` output and is
covered by sample plan JSON in
[`scripts/terraform-plan-summary.test.mjs`](../scripts/terraform-plan-summary.test.mjs):

```bash
node --test scripts/terraform-plan-summary.test.mjs
```

The workflow also runs these tests before planning.

## Local use

```bash
terraform -chdir=devops plan -out=plan.bin
terraform -chdir=devops show -json plan.bin > plan.json
node scripts/terraform-plan-summary.mjs --module devops=plan.json
```
