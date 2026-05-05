-- Sample migration file that demonstrates the linter.
-- Open this file with the extension installed to see the diagnostics.

-- ❌ Wastes 8 bytes per row to padding
CREATE TABLE users_bad (
    is_active   BOOLEAN NOT NULL DEFAULT true,
    email       VARCHAR(255) NOT NULL,
    id          BIGINT PRIMARY KEY,
    age         SMALLINT,
    created_at  TIMESTAMP NOT NULL,
    bio         TEXT
);

-- ✅ Optimal — fixed-width columns first, sorted by alignment, varlenas last
CREATE TABLE users_good (
    id          BIGINT PRIMARY KEY,
    created_at  TIMESTAMP NOT NULL,
    age         SMALLINT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    email       VARCHAR(255) NOT NULL,
    bio         TEXT
);

-- ❌ Classic bool-then-bigint (the canonical example)
CREATE TABLE events_bad (
    flag    BOOLEAN,
    big_id  BIGINT
);

-- Constraints inside the column list are preserved by the auto-fix
CREATE TABLE orders (
    flag         BOOLEAN,
    customer_id  BIGINT NOT NULL,
    total        NUMERIC(10, 2),
    PRIMARY KEY (customer_id),
    CONSTRAINT chk_total CHECK (total >= 0)
);
