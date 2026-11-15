# Developer commands for the personal-assistant project.
# `make` or `make help` lists the targets.

# docker-compose service name for the database.
DB_SVC := db
PSQL   := docker compose exec $(DB_SVC) psql -U advisor -d advisor

.PHONY: help db-up db-down db-wait db-apply db-reset db-psql db-logs db-status

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

db-up: ## Start postgres + adminer (detached)
	docker compose up -d

db-down: ## Stop containers (keeps data volume)
	docker compose down

db-wait: ## Block until postgres is accepting connections
	@echo "waiting for postgres..."
	@until docker compose exec -T $(DB_SVC) pg_isready -U advisor -d advisor >/dev/null 2>&1; do \
		sleep 1; \
	done
	@echo "postgres is ready"

db-apply: ## Apply db/schema.sql to the running database
	docker compose exec -T $(DB_SVC) psql -U advisor -d advisor -v ON_ERROR_STOP=1 < db/schema.sql
	@echo "schema applied"

db-reset: ## Wipe the data volume, start fresh, and re-apply the schema
	docker compose down -v
	$(MAKE) db-up
	$(MAKE) db-wait
	$(MAKE) db-apply

db-psql: ## Open an interactive psql shell inside the container
	$(PSQL)

db-logs: ## Follow the postgres logs
	docker compose logs -f $(DB_SVC)

db-status: ## Show container status
	docker compose ps
