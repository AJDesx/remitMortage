# Multi-Region Failover Variables

variable "primary_region" {
  type        = string
  description = "Primary AWS region for indexing"
  default     = "us-east-1"
}

variable "secondary_region" {
  type        = string
  description = "Secondary AWS region for failover"
  default     = "eu-west-1"
}

variable "domain_name" {
  type        = string
  description = "Domain name for the protocol"
  default     = "remit-mortgage.io"
}

variable "api_port" {
  type        = number
  description = "API port for health checks"
  default     = 8080
}

variable "health_check_interval" {
  type        = number
  description = "Health check interval in seconds"
  default     = 30
}

variable "failure_threshold" {
  type        = number
  description = "Number of consecutive failures before marking unhealthy"
  default     = 3
}

variable "failover_ttl" {
  type        = number
  description = "DNS TTL for failover records in seconds"
  default     = 60
}

variable "alert_email" {
  type        = string
  description = "Email address for failover alerts"
}

variable "primary_instance_type" {
  type        = string
  description = "EC2 instance type for primary region"
  default     = "t3.large"
}

variable "secondary_instance_type" {
  type        = string
  description = "EC2 instance type for secondary region"
  default     = "t3.large"
}

variable "secondary_instance_count" {
  type        = number
  description = "Number of instances in secondary region"
  default     = 2
}

variable "environment" {
  type        = string
  description = "Environment name (prod, staging, dev)"
  default     = "prod"
}

variable "tags" {
  type        = map(string)
  description = "Common tags to apply to all resources"
  default = {
    "Project"     = "RemitMortgage"
    "ManagedBy"   = "Terraform"
    "Component"   = "MultiRegionFailover"
  }
}

variable "owner" {
  description = "Team or individual accountable for these resources (required cost-allocation tag)"
  type        = string
  default     = "platform-team"

  validation {
    condition     = length(trimspace(var.owner)) > 0
    error_message = "owner must not be empty."
  }
}

variable "cost_center" {
  description = "Cost center the spend is attributed to (required cost-allocation tag)"
  type        = string
  default     = "remitmortgage-core"

  validation {
    condition     = length(trimspace(var.cost_center)) > 0
    error_message = "cost_center must not be empty."
  }
}
