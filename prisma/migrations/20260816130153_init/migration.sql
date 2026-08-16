-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'STOPPED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('DRAFT', 'SIMULATED', 'READY_FOR_REVIEW', 'APPROVED', 'APPLYING_TO_IIKO', 'APPLIED_TO_IIKO', 'PUBLISHED', 'FAILED', 'ROLLED_BACK', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SalesEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'DUPLICATE', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('IIKO_AUTH', 'IIKO_ORGANIZATIONS_SYNC', 'IIKO_MENU_SYNC', 'PRODUCT_SELECTED', 'PRODUCT_UPDATED', 'ROUND_CREATED', 'ROUND_SIMULATED', 'ROUND_APPROVED', 'ROUND_PUBLISHED', 'ROUND_ROLLED_BACK', 'WEBHOOK_RECEIVED', 'PLUGIN_QUOTE_REQUESTED', 'TELEGRAM_ALERT_SENT', 'ADMIN_ACTION');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "iiko_organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "is_selected" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_groups" (
    "id" UUID NOT NULL,
    "iiko_group_id" TEXT,
    "organization_id" UUID NOT NULL,
    "parent_iiko_group_id" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "iiko_product_id" TEXT NOT NULL,
    "iiko_parent_group_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT,
    "product_type" TEXT,
    "unit" TEXT,
    "base_price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "current_known_iiko_price" DECIMAL(12,2),
    "current_exchange_price" DECIMAL(12,2),
    "min_price" DECIMAL(12,2),
    "max_price" DECIMAL(12,2),
    "price_step" DECIMAL(12,2) NOT NULL DEFAULT 50,
    "max_change_percent" DECIMAL(6,2) NOT NULL DEFAULT 10,
    "is_exchange_product" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "image_url" TEXT,
    "metadata" JSONB,
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_rounds" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "round_key" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'DRAFT',
    "algorithm_version" TEXT NOT NULL,
    "trigger_source" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_prices" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "previous_price" DECIMAL(12,2) NOT NULL,
    "calculated_price" DECIMAL(12,2) NOT NULL,
    "published_price" DECIMAL(12,2),
    "min_price" DECIMAL(12,2) NOT NULL,
    "max_price" DECIMAL(12,2) NOT NULL,
    "price_step" DECIMAL(12,2) NOT NULL,
    "sales_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "demand_score" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "change_percent" DECIMAL(8,4) NOT NULL,
    "calculation_input" JSONB NOT NULL,
    "calculation_result" JSONB NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'SIMULATED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID,
    "external_event_id" TEXT NOT NULL,
    "iiko_order_id" TEXT,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(12,2),
    "occurred_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SalesEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "raw_payload" JSONB,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iiko_sync_attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "round_id" UUID,
    "operation" TEXT NOT NULL,
    "request_reference" TEXT,
    "request_metadata" JSONB,
    "response_status" INTEGER,
    "response_metadata" JSONB,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iiko_sync_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "organization_id" UUID,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "request_id" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_iiko_organization_id_key" ON "organizations"("iiko_organization_id");

-- CreateIndex
CREATE INDEX "organizations_is_selected_idx" ON "organizations"("is_selected");

-- CreateIndex
CREATE INDEX "product_groups_organization_id_name_idx" ON "product_groups"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_groups_organization_id_iiko_group_id_key" ON "product_groups"("organization_id", "iiko_group_id");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE INDEX "products_is_exchange_product_idx" ON "products"("is_exchange_product");

-- CreateIndex
CREATE INDEX "products_is_active_idx" ON "products"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_iiko_product_id_key" ON "products"("organization_id", "iiko_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_rounds_round_key_key" ON "price_rounds"("round_key");

-- CreateIndex
CREATE INDEX "price_rounds_organization_id_starts_at_idx" ON "price_rounds"("organization_id", "starts_at");

-- CreateIndex
CREATE INDEX "price_rounds_status_idx" ON "price_rounds"("status");

-- CreateIndex
CREATE INDEX "round_prices_product_id_idx" ON "round_prices"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_prices_round_id_product_id_key" ON "round_prices"("round_id", "product_id");

-- CreateIndex
CREATE INDEX "sales_events_organization_id_received_at_idx" ON "sales_events"("organization_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_events_source_external_event_id_key" ON "sales_events"("source", "external_event_id");

-- CreateIndex
CREATE INDEX "iiko_sync_attempts_operation_started_at_idx" ON "iiko_sync_attempts"("operation", "started_at");

-- CreateIndex
CREATE INDEX "iiko_sync_attempts_status_idx" ON "iiko_sync_attempts"("status");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rounds" ADD CONSTRAINT "price_rounds_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_prices" ADD CONSTRAINT "round_prices_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "price_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_prices" ADD CONSTRAINT "round_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_events" ADD CONSTRAINT "sales_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iiko_sync_attempts" ADD CONSTRAINT "iiko_sync_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iiko_sync_attempts" ADD CONSTRAINT "iiko_sync_attempts_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "price_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
