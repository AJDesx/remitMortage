variable "aws_region" {
  description = "AWS region for the APM/tracing infrastructure"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "remitmortgage"
}

variable "environment" {
  description = "Environment name (dev, staging, production)"
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the APM VPC"
  type        = string
  default     = "10.200.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones to spread the collector across"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "jaeger_image" {
  description = <<-EOT
    Container image for the Jaeger all-in-one collector. Jaeger natively
    accepts OTLP (gRPC on 4317, HTTP on 4318) since 1.35, so a single service
    doubles as the trace collector, storage, query API, and UI — no separate
    OpenTelemetry Collector is required for this deployment's scale.
  EOT
  type        = string
  default     = "jaegertracing/all-in-one:1.60"
}

variable "jaeger_cpu" {
  description = "Fargate task vCPU units for the Jaeger service (256 = 0.25 vCPU)"
  type        = number
  default     = 512
}

variable "jaeger_memory" {
  description = "Fargate task memory (MiB) for the Jaeger service"
  type        = number
  default     = 1024
}

variable "otlp_grpc_port" {
  description = "Port the collector accepts OTLP/gRPC trace exports on"
  type        = number
  default     = 4317
}

variable "otlp_http_port" {
  description = "Port the collector accepts OTLP/HTTP trace exports on"
  type        = number
  default     = 4318
}

variable "ui_port" {
  description = "Port the Jaeger query UI listens on"
  type        = number
  default     = 16686
}

variable "allowed_ui_cidrs" {
  description = "CIDR blocks allowed to reach the Jaeger UI through the ALB. Restrict this in production."
  type        = list(string)
  default     = ["0.0.0.0/0"] # Restrict this in production.
}

variable "app_source_cidrs" {
  description = <<-EOT
    CIDR blocks allowed to send OTLP traces to the collector — typically the
    CIDR of the backend's VPC connector/subnets (see devops/main.tf's
    `aws_apprunner_vpc_connector.main` subnets, or that module's VPC CIDR
    output) so the Express backend can reach the collector across VPCs.
  EOT
  type        = list(string)
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "trace_retention_hours" {
  description = <<-EOT
    How long Jaeger's in-memory span storage keeps traces before evicting
    them (SPAN_STORAGE_TYPE=memory, suitable for this deployment's traffic
    volume). Point Jaeger at Elasticsearch/Cassandra instead for durable,
    longer-lived retention in a higher-traffic environment.
  EOT
  type        = number
  default     = 48
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
