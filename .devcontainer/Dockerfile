# syntax=docker/dockerfile:1
#
# RemitMortgage development container image (issue #878).
#
# Pins the exact toolchains a contributor needs so "works on my machine" is a
# property of the image rather than the host:
#   * Node.js 22 (matches backend/Dockerfile) + npm
#   * Rust stable with clippy, rustfmt and the wasm targets the contracts use
#   * PostgreSQL/Redis clients and a C toolchain for native modules
#
# CI builds this image (.github/workflows/devcontainer.yml) so it can never rot.

FROM node:22-bookworm

ARG RUST_VERSION=stable
ENV DEBIAN_FRONTEND=noninteractive

# System packages: build toolchain for native deps + cargo crates, the DB/Redis
# clients used for local checks, and general developer utilities.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        jq \
        libssl-dev \
        make \
        pkg-config \
        postgresql-client \
        redis-tools \
    && rm -rf /var/lib/apt/lists/*

USER node
ENV RUSTUP_HOME=/home/node/.rustup \
    CARGO_HOME=/home/node/.cargo \
    PATH=/home/node/.cargo/bin:${PATH}

# Rust stable + the components/targets the contracts workspace needs. The
# wasm targets are what CONTRIBUTING.md and the contracts CI jobs require.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && rustup component add clippy rustfmt \
    && rustup target add wasm32-unknown-unknown wasm32v1-none \
    && rustc --version \
    && cargo --version

# Pre-create the workspace mount point so the devcontainer CLI can mount over it.
WORKDIR /workspaces/remitMortgage
