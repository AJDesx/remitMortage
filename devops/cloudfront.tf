# ─────────────────────────────────────────────────────────────────────────
# CloudFront CDN – Edge Caching for Next.js Frontend
# ─────────────────────────────────────────────────────────────────────────
# This distribution sits in front of the Next.js application server
# (App Runner / ALB) and caches static build artefacts at AWS edge
# locations for faster global page loads.
#
# Cache lay-out
# ─────────────
#   _next/static/*   – Immutable content-hashed assets → 1 year edge TTL
#   public/*          – Hand-versioned static files → 1 year edge TTL
#   *.jpg/*.png/*.svg – Image resources → 1 week
#   /api/*            – Dynamic API → no caching
#   default (*)       – SSR pages / other → 10 min, revalidate on origin

# ── Managed cache policy IDs (AWS-provided, no extra cost) ──────────────
# "CachingOptimized"          -> 658327ea-f89d-4fab-a63d-7e88639e58f6
# "CachingDisabled"           -> 4135ea2d-6df8-44a3-9df3-4b5a84be39ad

locals {
  cache_policy_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  cache_policy_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
}

resource "aws_wafv2_web_acl" "public_api" {
  provider = aws
  name     = "remitmortgage-public-api-${var.environment}"
  scope    = "CLOUDFRONT"

  default_action { allow {} }

  rule {
    name     = "aws-managed-common-rules"
    priority = 10
    dynamic "override_action" {
      for_each = var.waf_enforce_blocking ? [] : [true]
      content { count {} }
    }
    dynamic "action" {
      for_each = var.waf_enforce_blocking ? [true] : []
      content { block {} }
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "public-api-common-rules"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "api-rate-limit"
    priority = 20
    action {
      dynamic "block" {
        for_each = var.waf_enforce_blocking ? [true] : []
        content {}
      }
      dynamic "count" {
        for_each = var.waf_enforce_blocking ? [] : [true]
        content {}
      }
    }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_five_minutes
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            field_to_match { uri_path {} }
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/"
            text_transformation { priority = 0 type = "NONE" }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "public-api-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = length(var.waf_blocked_country_codes) > 0 ? [true] : []
    content {
      name     = "blocked-geo-countries"
      priority = 30
      action {
        dynamic "block" {
          for_each = var.waf_enforce_blocking ? [true] : []
          content {}
        }
        dynamic "count" {
          for_each = var.waf_enforce_blocking ? [] : [true]
          content {}
        }
      }
      statement {
        geo_match_statement { country_codes = var.waf_blocked_country_codes }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "public-api-geo-rule"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "remitmortgage-public-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_logging_configuration" "public_api" {
  resource_arn            = aws_wafv2_web_acl.public_api.arn
  log_destination_configs = [aws_s3_bucket.waf_logs.arn]
}

resource "aws_s3_bucket" "waf_logs" {
  bucket = "aws-waf-logs-remitmortgage-${var.environment}"
  tags = {
    Name        = "aws-waf-logs-remitmortgage-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "waf_logs" {
  bucket = aws_s3_bucket.waf_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "waf_logs" {
  bucket = aws_s3_bucket.waf_logs.id
  rule {
    id     = "expire-waf-logs"
    status = "Enabled"
    expiration { days = 90 }
  }
}

data "aws_iam_policy_document" "waf_logs" {
  statement {
    sid    = "AllowWafLogDelivery"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.waf_logs.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "waf_logs" {
  bucket = aws_s3_bucket.waf_logs.id
  policy = data.aws_iam_policy_document.waf_logs.json
}

# ── Custom cache policy for immutable Next.js build assets ─────────────
resource "aws_cloudfront_cache_policy" "nextjs_static_immutable" {
  name        = "NextJsStaticImmutable-${var.environment}"
  comment     = "1-year TTL for content-hashed _next/static/* assets"
  min_ttl     = 0
  default_ttl = 86400    # 1 day on the "stale" end
  max_ttl     = 31536000 # 1 year

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# ── CloudFront distribution ────────────────────────────────────────────
resource "aws_cloudfront_distribution" "frontend" {
  enabled     = true
  web_acl_id  = aws_wafv2_web_acl.public_api.arn
  comment     = "RemitMortage Next.js frontend – ${var.environment}"
  price_class = "PriceClass_All" # all edge locations globally
  aliases     = compact([var.app_domain_name, var.www_domain_name])

  # Origin – the Next.js application server (App Runner / ALB)
  origin {
    domain_name = var.frontend_origin_domain
    origin_id   = "nextjs-origin"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60  # Next.js SSR can be slow on cold boot
      origin_keepalive_timeout = 5
    }

    connection_attempts = 3
    connection_timeout  = 10
  }

  # ── Default behaviour: SSR pages and catch-all ──────────────────────────
  default_cache_behavior {
    target_origin_id       = "nextjs-origin"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id = local.cache_policy_optimized

    # Next.js reads the session cookie; forward it so SSR works
    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_default.id

    response_headers_policy_id = aws_cloudfront_response_headers_policy.nextjs_security.id
  }

  # ── Immutable Next.js build assets ──────────────────────────────────────
  ordered_cache_behavior {
    path_pattern     = "_next/static/*"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy    = "redirect-to-https"
    cache_policy_id           = aws_cloudfront_cache_policy.nextjs_static_immutable.id
    origin_request_policy_id  = aws_cloudfront_origin_request_policy.nextjs_managed_origin.id
  }

  # ── Public directory static files ───────────────────────────────────────
  ordered_cache_behavior {
    path_pattern     = "public/*"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = aws_cloudfront_cache_policy.nextjs_static_immutable.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_managed_origin.id
  }

  # ── Image files ─────────────────────────────────────────────────────────
  ordered_cache_behavior {
    path_pattern     = "*.jpg"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = local.cache_policy_optimized

    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_managed_origin.id
  }

  ordered_cache_behavior {
    path_pattern     = "*.png"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = local.cache_policy_optimized
    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_managed_origin.id
  }

  ordered_cache_behavior {
    path_pattern     = "*.svg"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = local.cache_policy_optimized
    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_managed_origin.id
  }

  ordered_cache_behavior {
    path_pattern     = "*.ico"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = local.cache_policy_optimized
    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_managed_origin.id
  }

  # ── Webpack / SWC wasm files (may appear under _next) ──────────────────
  ordered_cache_behavior {
    path_pattern     = "*.wasm"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = local.cache_policy_optimized
    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_managed_origin.id
  }

  # ── API routes – never cache ────────────────────────────────────────────
  ordered_cache_behavior {
    path_pattern     = "/api/*"
    target_origin_id = "nextjs-origin"
    compress         = true

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = local.cache_policy_disabled
    origin_request_policy_id = aws_cloudfront_origin_request_policy.nextjs_default.id
  }

  # ── Restrictions & certificate ─────────────────────────────────────────
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ── Logging ────────────────────────────────────────────────────────────
  logging_config {
    include_cookies = false
    bucket          = aws_s3_bucket.cloudfront_logs.bucket_domain_name
    prefix          = "cdn/${var.environment}/"
  }

  tags = {
    Name        = "remitmortage-cdn-${var.environment}"
    Environment = var.environment
    Component   = "CDN"
  }
}

# ── Origin request policy: forward the Host header + query string ─────────
# CloudFront's Managed-AllViewer policy is too permissive; we create a
# minimal policy that lets Next.js see the Host and query parameters.
resource "aws_cloudfront_origin_request_policy" "nextjs_default" {
  name    = "NextJsDefault-${var.environment}"
  comment = "Forward Host header + query string for SSR routing"

  cookies_config {
    cookie_behavior = "all"
  }

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["CloudFront-Forwarded-Proto", "Host"]
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

# Origin request policy: no cookies, no query string (for static assets)
resource "aws_cloudfront_origin_request_policy" "nextjs_managed_origin" {
  name    = "NextJsStaticOrigin-${var.environment}"
  comment = "Strip cookies and query string for cached static assets"

  cookies_config {
    cookie_behavior = "none"
  }

  headers_config {
    header_behavior = "none"
  }

  query_strings_config {
    query_string_behavior = "none"
  }
}

# ── S3 bucket for CloudFront access logs ─────────────────────────────────
resource "aws_s3_bucket" "cloudfront_logs" {
  bucket = "remitmortage-cdn-logs-${var.environment}"

  tags = {
    Name        = "remitmortage-cdn-logs-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    expiration {
      days = 90
    }
  }
}

# Bucket policy that allows CloudFront to write access logs
data "aws_iam_policy_document" "cloudfront_logs" {
  statement {
    sid    = "AllowCloudFrontLogDelivery"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cloudfront_logs.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id
  policy = data.aws_iam_policy_document.cloudfront_logs.json
}

# ── Response headers policy: security & CORS for assets ──────────────────
resource "aws_cloudfront_response_headers_policy" "nextjs_security" {
  name    = "NextJsSecurityHeaders-${var.environment}"
  comment = "Recommended security headers + CORS for Next.js"

  security_headers_config {
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = "63072000"
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    xss_protection {
      protection = true
      mode_block = true
      override   = true
    }
    content_security_policy {
      # Mirrors next.config.ts CSP; tighten in production
      content_security_policy = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.gstatic.com; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
      override                = true
    }
  }

  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers {
      items = ["*"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }
    access_control_allow_origins {
      items = ["*"]
    }
    access_control_expose_headers {
      items = ["ETag"]
    }
    access_control_max_age_sec = 600
    origin_override            = true
  }

  custom_headers_config {
    items {
      header = "X-Content-Type-Options"
      value  = "nosniff"
      override = true
    }
  }
}

# ── Outputs ──────────────────────────────────────────────────────────────
output "cloudfront_domain" {
  value       = aws_cloudfront_distribution.frontend.domain_name
  description = "CloudFront distribution domain name (for Route53 alias)"
}

output "cloudfront_distribution_id" {
  value       = aws_cloudfront_distribution.frontend.id
  description = "CloudFront distribution ID"
}
