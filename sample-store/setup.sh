#!/usr/bin/env bash
# Sample Magento store for playwright-lite-mcp: Mage-OS + Hyvä (open source) + sample data on Warden.
# No Adobe (repo.magento.com) or Hyvä packagist keys needed: Mage-OS is a public mirror of
# Magento Open Source, Hyvä packages are pulled straight from github.com/hyva-themes.
#
# Usage: sample-store/setup.sh [target-dir]     (default: ~/Documents/hyva-demo)
# Env:   ENV_NAME=hyva-demo  MAGEOS_VERSION=4.0.0  SAMPLE_DATA=1
#
# Idempotent-ish: every step checks whether it already ran, so a failed run can be restarted.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_NAME="${ENV_NAME:-hyva-demo}"
DOMAIN="${ENV_NAME}.test"
BASE_URL="https://app.${DOMAIN}/"
DIR="${1:-$HOME/Documents/$ENV_NAME}"
MAGEOS_VERSION="${MAGEOS_VERSION:-4.0.0}"
SAMPLE_DATA="${SAMPLE_DATA:-1}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-Admin123!demo}"

# Hyvä open-source packages (dependency closure of default-theme + luma-checkout).
HYVA_REPOS=(
  magento2-default-theme magento2-theme-module magento2-base-layout-reset magento2-email-module
  magento2-order-cancellation-webapi magento2-mollie-theme-bundle magento2-compat-module-fallback
  magento2-luma-checkout magento2-theme-fallback magento2-graphql-tokens magento2-graphql-view-model
)

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
php() { warden env exec -T php-fpm "$@"; }
mage() { php bin/magento "$@"; }
sql() { warden env exec -T db mysql -umagento -pmagento magento -Nse "$1"; }

command -v warden >/dev/null || { echo "warden not found (brew install wardenenv/warden/warden)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 1; }

mkdir -p "$DIR"
cd "$DIR"

if [[ ! -f .env ]]; then
  log "warden env-init $ENV_NAME magento2"
  warden env-init "$ENV_NAME" magento2
  # Keep the stack small: no RabbitMQ (cron consumers not needed for a demo shop).
  sed -i '' 's/^WARDEN_RABBITMQ=1/WARDEN_RABBITMQ=0/' .env
fi

log "TLS certificate + global services"
[[ -f "$HOME/.warden/ssl/certs/${DOMAIN}.crt.pem" ]] || warden sign-certificate "$DOMAIN"
warden svc up

log "warden env up"
warden env up

log "Waiting for MariaDB"
for _ in $(seq 1 60); do
  warden env exec -T db mysqladmin ping -umagento -pmagento --silent >/dev/null 2>&1 && break
  sleep 2
done

if [[ ! -f composer.json ]]; then
  log "Mage-OS $MAGEOS_VERSION (composer create-project)"
  php bash -c "rm -rf /tmp/mageos && composer create-project --no-interaction --no-install \
      --repository-url=https://repo.mage-os.org/ mage-os/project-community-edition /tmp/mageos $MAGEOS_VERSION \
    && rsync -a /tmp/mageos/ /var/www/html/ && rm -rf /tmp/mageos"
fi

if ! grep -q 'hyva-themes/magento2-default-theme' composer.json; then
  log "Hyvä repositories (GitHub, no key)"
  for r in "${HYVA_REPOS[@]}"; do
    php composer config "repositories.hyva-${r#magento2-}" \
      "{\"type\":\"vcs\",\"url\":\"https://github.com/hyva-themes/${r}\",\"no-api\":true}"
  done
  php composer require --no-interaction --no-update \
    hyva-themes/magento2-default-theme hyva-themes/magento2-luma-checkout
fi

if [[ ! -d vendor/magento/framework && ! -d vendor/mage-os/framework ]] || [[ ! -d vendor/hyva-themes ]]; then
  log "composer install"
  php composer update --no-interaction
fi

if [[ ! -f app/etc/env.php ]]; then
  if [[ "$SAMPLE_DATA" == "1" ]]; then
    log "Sample data"
    php bash -c 'bin/magento sampledata:deploy && composer update --no-interaction'
  fi

  log "setup:install"
  mage setup:install \
    --base-url="$BASE_URL" --base-url-secure="$BASE_URL" \
    --use-secure=1 --use-secure-admin=1 --use-rewrites=1 \
    --backend-frontname=backend \
    --db-host=db --db-name=magento --db-user=magento --db-password=magento \
    --search-engine=opensearch --opensearch-host=opensearch --opensearch-port=9200 \
    --opensearch-index-prefix=magento2 --opensearch-enable-auth=0 --opensearch-timeout=15 \
    --http-cache-hosts=varnish:80 \
    --session-save=redis --session-save-redis-host=redis --session-save-redis-port=6379 \
    --session-save-redis-db=2 --session-save-redis-max-concurrency=20 \
    --cache-backend=redis --cache-backend-redis-server=redis --cache-backend-redis-db=0 \
    --cache-backend-redis-port=6379 \
    --page-cache=redis --page-cache-redis-server=redis --page-cache-redis-db=1 \
    --page-cache-redis-port=6379 \
    --admin-firstname=Demo --admin-lastname=Admin --admin-email=admin@example.com \
    --admin-user="$ADMIN_USER" --admin-password="$ADMIN_PASS" \
    --language=en_US --currency=USD --timezone=UTC --cleanup-database
fi

log "Store configuration"
# 2FA blocks automated admin logins in a local demo.
mage module:disable -c Magento_AdminAdobeImsTwoFactorAuth Magento_TwoFactorAuth 2>/dev/null || true
mage setup:upgrade --keep-generated
mage deploy:mode:set developer
# Full page cache via Varnish: lets agents check X-Magento-Cache-Debug HIT/MISS.
mage config:set system/full_page_cache/caching_application 2
mage config:set system/full_page_cache/varnish/backend_host nginx
mage config:set system/full_page_cache/varnish/backend_port 80
mage config:set web/seo/use_rewrites 1
mage config:set admin/security/session_lifetime 86400

THEME_ID="$(sql "SELECT theme_id FROM theme WHERE theme_path='Hyva/default' AND area='frontend'")"
[[ -n "$THEME_ID" ]] || { echo "Hyva/default theme not registered"; exit 1; }
mage config:set design/theme/theme_id "$THEME_ID"
# Hyvä open source has no checkout of its own: luma-checkout falls back to Luma on /checkout.

mage indexer:reindex
mage cache:flush

log "Done"
cat <<EOF
Storefront: $BASE_URL
Admin:      ${BASE_URL}backend  ($ADMIN_USER / $ADMIN_PASS)
Check:      $HERE/check.sh
EOF
