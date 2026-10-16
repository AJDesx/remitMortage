"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import RouteErrorFallback from "@/components/RouteErrorFallback";

// Route-level boundary: a render crash in any page shows the fallback inside
// the app layout (navbar, theme) instead of a blank page.
export default RouteErrorFallback;
