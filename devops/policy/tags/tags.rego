# Cost-allocation tag policy for Terraform plans.
#
# Evaluated by conftest against `terraform show -json <planfile>`:
#
#   terraform plan -out=tfplan && terraform show -json tfplan > plan.json
#   conftest test --policy devops/policy/tags --namespace terraform.tags plan.json
#
# Every taggable resource that a plan creates or updates must end up with the
# required tag set in `tags_all` (resource tags merged with the provider's
# `default_tags`), each with a non-empty value. See
# docs/COST_ALLOCATION_TAG_POLICY.md.
package terraform.tags

import rego.v1

required_tags := {"Service", "Environment", "Owner", "CostCenter"}

# Resource types that expose a `tags_all` attribute but cannot be attributed to
# an owner on their own (they inherit billing from their parent resource).
exempt_types := {
	"aws_db_parameter_group_association",
	"aws_route_table_association",
}

# Resources the plan will create or update (deletes and no-ops cost nothing new).
changed_resources contains rc if {
	some rc in input.resource_changes
	some action in rc.change.actions
	action in {"create", "update"}
	not rc.type in exempt_types
	is_taggable(rc)
}

# A resource is taggable when the provider schema surfaced `tags_all`, either as
# a known value or as "known after apply".
is_taggable(rc) if "tags_all" in object.keys(object.get(rc.change, "after", {}))

is_taggable(rc) if object.get(object.get(rc.change, "after_unknown", {}), "tags_all", false) == true

# Effective tags are only knowable when `tags_all` is resolved in the plan.
tags_known(rc) if not object.get(object.get(rc.change, "after_unknown", {}), "tags_all", false) == true

effective_tags(rc) := object.get(rc.change.after, "tags_all", {}) if tags_known(rc)

missing_tags(rc) := missing if {
	tags := effective_tags(rc)
	missing := {t |
		some t in required_tags
		not has_value(tags, t)
	}
}

has_value(tags, key) if {
	v := tags[key]
	is_string(v)
	trim_space(v) != ""
}

deny contains msg if {
	some rc in changed_resources
	tags_known(rc)
	missing := missing_tags(rc)
	count(missing) > 0
	msg := sprintf(
		"%s is missing required cost-allocation tag(s): %s. Set them via the provider default_tags or the resource's tags.",
		[rc.address, concat(", ", sort(missing))],
	)
}

# `tags_all` is computed (e.g. tags derive from another resource's output), so
# the plan cannot prove compliance. Surface it without blocking.
warn contains msg if {
	some rc in changed_resources
	not tags_known(rc)
	msg := sprintf("%s: tags_all is unknown until apply, required tags could not be verified.", [rc.address])
}
