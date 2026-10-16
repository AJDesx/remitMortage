# Inputs for the health-checked DNS failover module (issue #876).

variable "hosted_zone_name" {
  description = "Route 53 public hosted zone that owns the failover record (e.g. \"remitmortgage.com\")."
  type        = string
}

variable "record_name" {
  description = "Name of the failover record (e.g. \"api.remitmortgage.com\" or \"api\")."
  type        = string
}

variable "primary_target" {
  description = "Primary regional endpoint the record points to while it is healthy."
  type        = string
}

variable "secondary_target" {
  description = "Secondary (failover) regional endpoint used when the primary is unhealthy."
  type        = string
}

variable "record_type" {
  description = "DNS record type for the failover pair. CNAME for hostnames, A for IP targets."
  type        = string
  default     = "CNAME"

  validation {
    condition     = contains(["A", "CNAME"], var.record_type)
    error_message = "record_type must be either \"A\" or \"CNAME\"."
  }
}

variable "primary_ttl" {
  description = "TTL (seconds) for the primary record. Kept low so resolvers drop a stale primary quickly."
  type        = number
  default     = 30
}

variable "secondary_ttl" {
  description = "TTL (seconds) for the secondary record."
  type        = number
  default     = 30
}

variable "health_check_interval" {
  description = "Seconds between health-check probes. Route 53 supports 10 or 30 (fast checks cost more)."
  type        = number
  default     = 10

  validation {
    condition     = contains([10, 30], var.health_check_interval)
    error_message = "health_check_interval must be 10 or 30 seconds."
  }
}

variable "failure_threshold" {
  description = "Consecutive failed probes before a target is marked unhealthy."
  type        = number
  default     = 3
}

variable "health_check_type" {
  description = "Health-check protocol used to probe each regional endpoint."
  type        = string
  default     = "HTTPS"

  validation {
    condition     = contains(["HTTP", "HTTPS"], var.health_check_type)
    error_message = "health_check_type must be either \"HTTP\" or \"HTTPS\"."
  }
}

variable "health_check_port" {
  description = "Port the health check connects to."
  type        = number
  default     = 443
}

variable "health_check_path" {
  description = "Path probed by the health check."
  type        = string
  default     = "/api/health"
}

variable "environment" {
  description = "Deployment environment (dev, staging, production)."
  type        = string
}

variable "alarm_sns_topic_arn" {
  description = "Existing SNS topic ARN for failover alerts. When empty, a topic is created."
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Email subscribed to the failover alerts topic (only used when this module creates the topic)."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default = {
    Project   = "RemitMortgage"
    ManagedBy = "Terraform"
    Component = "DnsFailover"
  }
}
