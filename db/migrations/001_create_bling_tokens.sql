-- Migration: Tabela bling_tokens para persistência automática de OAuth 2.0 (Bling API v3)
-- Compatível com PostgreSQL / Supabase / MySQL (ajustando TIMESTAMPTZ para DATETIME se MySQL)

CREATE TABLE IF NOT EXISTS bling_tokens (
  id INTEGER PRIMARY KEY DEFAULT 1,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  token_type VARCHAR(32) NOT NULL DEFAULT 'Bearer',
  scope TEXT DEFAULT '',
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bling_tokens_singleton CHECK (id = 1)
);

CREATE INDEX IF NOT EXISTS idx_bling_tokens_expires_at ON bling_tokens (expires_at);
