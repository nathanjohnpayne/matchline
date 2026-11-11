# bootstrap-config.sh — Repo-specific 1Password template mappings
#
# Each INJECT_FILES entry: "template_path:output_path"
# Templates contain op:// references resolved by `op inject`.
# Templates are committed to git; generated output files are gitignored.
#
# To add a file:
#   1. Add its values as fields in the "matchline env" item (Private vault),
#      in a section named for the file.
#   2. Commit a template next to the output with {{ op://... }} references.
#   3. Add "template:output" below, then run ./scripts/bootstrap.sh --force.

INJECT_FILES=(
  # Item "matchline env" (Private vault): section "web" and section
  # "functions-matchline-dev".
  ".env.tpl:.env.local"
  "functions/.env.matchline-dev.tpl:functions/.env.matchline-dev"
)

# Secure Note (notesPlain) storage is retired upstream (mergepath#364);
# keep this empty.
BOOTSTRAP_FILES=()
