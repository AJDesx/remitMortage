package terraform.tags_test

import rego.v1

import data.terraform.tags

full_tags := {
	"Service": "backend",
	"Environment": "staging",
	"Owner": "platform-team",
	"CostCenter": "remitmortgage-core",
}

rc(address, type, actions, after) := {
	"address": address,
	"type": type,
	"change": {"actions": actions, "after": after, "after_unknown": {}},
}

plan(changes) := {"resource_changes": changes}

test_compliant_plan_passes if {
	p := plan([
		rc("aws_vpc.main", "aws_vpc", ["create"], {"tags_all": full_tags}),
		rc("aws_db_instance.postgres", "aws_db_instance", ["update"], {"tags_all": full_tags}),
	])
	count(tags.deny) == 0 with input as p
}

test_resource_without_any_tags_fails if {
	p := plan([rc("aws_s3_bucket.logs", "aws_s3_bucket", ["create"], {"tags_all": {}})])
	msgs := tags.deny with input as p
	count(msgs) == 1
	some m in msgs
	contains(m, "aws_s3_bucket.logs")
	contains(m, "CostCenter, Environment, Owner, Service")
}

test_partially_tagged_resource_lists_only_missing_keys if {
	p := plan([rc("aws_vpc.main", "aws_vpc", ["create"], {"tags_all": {"Service": "backend", "Environment": "dev"}})])
	msgs := tags.deny with input as p
	some m in msgs
	contains(m, "CostCenter, Owner")
	not contains(m, "Service,")
}

test_empty_tag_value_fails if {
	bad := object.union(full_tags, {"Owner": "  "})
	p := plan([rc("aws_vpc.main", "aws_vpc", ["create"], {"tags_all": bad})])
	count(tags.deny) == 1 with input as p
}

test_every_untagged_resource_is_reported if {
	p := plan([
		rc("aws_vpc.a", "aws_vpc", ["create"], {"tags_all": {}}),
		rc("aws_vpc.b", "aws_vpc", ["create"], {"tags_all": {}}),
	])
	count(tags.deny) == 2 with input as p
}

test_destroyed_resources_are_ignored if {
	p := plan([rc("aws_vpc.old", "aws_vpc", ["delete"], {"tags_all": {}})])
	count(tags.deny) == 0 with input as p
}

test_unchanged_resources_are_ignored if {
	p := plan([rc("aws_vpc.same", "aws_vpc", ["no-op"], {"tags_all": {}})])
	count(tags.deny) == 0 with input as p
}

test_non_taggable_resources_are_ignored if {
	p := plan([rc("aws_iam_role_policy.p", "aws_iam_role_policy", ["create"], {"policy": "{}"})])
	count(tags.deny) == 0 with input as p
}

test_exempt_types_are_ignored if {
	p := plan([rc("aws_route_table_association.a", "aws_route_table_association", ["create"], {"tags_all": {}})])
	count(tags.deny) == 0 with input as p
}

test_replace_is_checked if {
	p := plan([rc("aws_vpc.main", "aws_vpc", ["delete", "create"], {"tags_all": {}})])
	count(tags.deny) == 1 with input as p
}

test_unknown_tags_all_warns_instead_of_denying if {
	p := plan([{
		"address": "aws_instance.web",
		"type": "aws_instance",
		"change": {"actions": ["create"], "after": {}, "after_unknown": {"tags_all": true}},
	}])
	count(tags.deny) == 0 with input as p
	count(tags.warn) == 1 with input as p
}
