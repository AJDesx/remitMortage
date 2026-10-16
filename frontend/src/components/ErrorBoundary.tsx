"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import RouteErrorFallback from "./RouteErrorFallback";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Changing this value clears the error (e.g. pass the pathname). */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Client-side boundary for a subtree outside Next's per-route error.tsx
 * (modals, widgets). Route segments use error.tsx, which renders the same fallback.
 */
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) return <RouteErrorFallback error={this.state.error} reset={this.reset} />;
    return this.props.children;
  }
}
