# bootstrap-config.sh — Repo-specific 1Password item mappings
#
# Each entry: "1password_item_id:relative_file_path"
# The item's notesPlain field stores the file contents.
#
# To add a new file:
#   1. Store it: op item create --category="Secure Note" --title="<Repo> Local Config (<filename>)" --vault=Private --tags=bootstrap "notesPlain=$(cat <file>)"
#   2. Copy the item ID and add an entry below.

BOOTSTRAP_FILES=(
  # "Matchline Local Config (.env.local)": Firebase web config plus the
  # GA4 measurement ID and PostHog token (#665). All browser-public values.
  "4cycd542bjldo45lb65epoq7ni:.env.local"
)
