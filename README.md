# oh-my-pi gated permissions

## Overview

Oh-my-pi extension for gated permissions (similar to opencode).

If intercepted command is detected, it will present you with choices to deny command, allow it or always allow (for current session only). 

## Configuration

Use enivornment variable OMP_GATED_TOOLS:
OMP_GATED_TOOLS="bash,edit,lsp" - gates bash, edit and lsp.
OMP_GATED_TOOLS="*" - gates all tool calls.
OMP_GATED_TOOLS="" - YOLO mode, nothing is gated.

## Slash commands
/perms allow-all - return to YOLO mode in current session, which will disable all permission gates.
/perms list - list current (session) permission settings
/perms reset - reset to default.