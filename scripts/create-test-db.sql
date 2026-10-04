-- Creates the separate database used by integration tests (`pnpm test:int`).
-- Integration tests TRUNCATE tables, so they refuse to run against any
-- database whose name does not contain "test".
CREATE DATABASE docengine_test OWNER docengine;
