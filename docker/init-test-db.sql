-- Runs once, on first boot of an empty postgres data volume.
-- Creates the dedicated test database used by the *.int.test.ts suites.
CREATE DATABASE "420ai_test";
