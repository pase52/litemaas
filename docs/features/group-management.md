# Group Management

## Overview

Groups (internally called "teams") provide a way to organize users and manage shared access to AI models with collective budget and rate limit controls. Administrators create and configure groups, while group admins can manage membership and basic settings within their groups.

Groups integrate deeply with the API key system — when a user creates an API key linked to a group, the key inherits access to the group's allowed models (bypassing individual subscription requirements) and is scoped to the group's LiteLLM team budget.

## Key Features

- **Group CRUD**: Admins create, edit, soft-delete, and restore groups with name, alias, description
- **Model Allowlist**: Per-group control over which models are accessible; changes cascade to existing API keys
- **Budget & Rate Limits**: Max budget, budget duration, TPM, and RPM limits enforced via LiteLLM team
- **Three-Role Membership**: `admin`, `member`, `viewer` roles within each group with role hierarchy enforcement
- **API Key Association**: Users create API keys linked to a group to access group-allowed models
- **Dual Management Interfaces**: Admin Group Management page and user-facing My Groups page
- **LiteLLM Sync**: Full bidirectional synchronization of teams, members, budgets, and model access
- **Audit Trail**: All group operations logged to `audit_logs` table
- **9-Language i18n**: Full translations for all group UI elements

---

## RBAC Permissions

| Permission           | Role                 | Capabilities                             |
| -------------------- | -------------------- | ---------------------------------------- |
| `admin:groups:read`  | admin, adminReadonly  | View all groups, members, and budgets    |
| `admin:groups:write` | admin                | Create, update, delete groups and manage members |
| `groups:read`        | user                 | View own groups (membership enforced at service layer) |

**Within a group**, the `role` field on `team_members` provides additional access control:

| Group Role | Capabilities                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| `admin`    | Edit group details (name/alias/description), manage members, view budget     |
| `member`   | View group details, members, and budget; create group-linked API keys        |
| `viewer`   | View group details and members only; **not synced to LiteLLM** (local only)  |

---

## Data Model

### `teams` Table

| Column            | Type            | Notes                                             |
| ----------------- | --------------- | ------------------------------------------------- |
| `id`              | UUID PK         | `gen_random_uuid()`                               |
| `name`            | VARCHAR(255)    | NOT NULL, unique among active teams               |
| `alias`           | VARCHAR(255)    | Optional display alias (max 50 chars in schema)   |
| `description`     | TEXT            | Optional (max 500 chars in schema)                |
| `lite_llm_team_id`| VARCHAR(255)    | Foreign key to LiteLLM team                       |
| `max_budget`      | DECIMAL(10,2)   | Optional group budget ceiling                     |
| `current_spend`   | DECIMAL(10,2)   | Default 0, synced from LiteLLM                    |
| `budget_duration` | VARCHAR(20)     | `daily`, `weekly`, `monthly`, `yearly`            |
| `tpm_limit`       | INTEGER         | Tokens per minute limit                           |
| `rpm_limit`       | INTEGER         | Requests per minute limit                         |
| `allowed_models`  | TEXT[]           | Array of model IDs; empty = **no models** (non-default teams) |
| `metadata`        | JSONB           | Default `'{}'`                                    |
| `is_active`       | BOOLEAN         | Default `true`; soft-delete flag                  |
| `created_at`      | TIMESTAMPTZ     |                                                   |
| `updated_at`      | TIMESTAMPTZ     | Auto-updated via trigger                          |
| `created_by`      | UUID FK → users |                                                   |

> **Note**: The Default Team (`a0000000-0000-4000-8000-000000000001`) has special behavior — its empty `allowed_models` array enables access to **all** models. For non-default teams, an empty `allowed_models` means **no models** are accessible.

### `team_members` Table

| Column     | Type            | Notes                                     |
| ---------- | --------------- | ----------------------------------------- |
| `id`       | UUID PK         |                                           |
| `team_id`  | UUID FK → teams | ON DELETE CASCADE                         |
| `user_id`  | UUID FK → users | ON DELETE CASCADE                         |
| `role`     | VARCHAR(20)     | CHECK `('admin', 'member', 'viewer')`     |
| `joined_at`| TIMESTAMPTZ     |                                           |
| `added_by` | UUID FK → users |                                           |

**Constraints**: `UNIQUE(team_id, user_id)` — a user can only appear once per group.

### `api_keys.team_id` Column

- Type: `UUID REFERENCES teams(id) ON DELETE SET NULL`
- Optional group association per API key
- Indexed for lookup

---

## UI Components

### Admin Group Management (`/admin/groups`)

Accessible to `admin` and `adminReadonly` roles via the **Group Management** sidebar item.

**Data Table** with columns:
- **Name** (with alias subtitle)
- **Description**
- **Members** (count)
- **Models** (count, or "No models" for empty allowlist)
- **Budget** (spend / max)
- **Status** (Active/Inactive label)
- **Actions**

**Features**:
- Search by name/alias with URL parameter sync
- Status filter (All/Active/Inactive) with URL parameter sync
- Pagination with URL parameter sync
- Create Group button (admin only)
- Row click opens edit/view modal
- Delete with double-click confirmation pattern

**Group Edit Modal** (4 tabs):

#### 1. Details Tab (`GroupDetailsTab`)
- Name (required, 1-100 chars)
- Alias (optional, max 50 chars)
- Description (optional, max 500 chars)
- Status toggle (Active/Inactive) — edit mode only

#### 2. Models Tab (`GroupModelsTab`)
- Searchable checkbox list of all available models
- Select All / Clear Selection actions
- Shows count of selected models
- Changes cascade to existing team API keys on save

#### 3. Members Tab (`GroupMembersTab`)
- User search select (searches all users via admin endpoint)
- Role select (Admin/Member/Viewer) for new members
- Member table with role badges (color-coded by role)
- Inline role change actions
- Remove member with confirmation
- Last-admin protection (cannot remove or demote the last group admin)

#### 4. Budget & Limits Tab (`GroupBudgetTab`)
- Max Budget with progress bar showing utilization
- Budget Duration dropdown (daily/weekly/monthly/yearly)
- TPM Limit
- RPM Limit
- Progress bar color coding: green (< 80%), warning (80-95%), danger (> 95%)

### My Groups (`/groups`)

Accessible to all authenticated users via the **My Groups** sidebar item.

**Data Table** with columns:
- **Name** (with alias)
- **Description** (truncated at 80 chars)
- **My Role** (color-coded badge: Admin=blue, Member=green, Viewer=grey)
- **Members** (with icon)
- **Models**
- **Status**
- **Actions** (Manage for group admins, View for others)

**My Group Modal** (2 tabs):

#### 1. Details Tab
- Limited editing: name, alias, description only (group admins)
- Read-only for members and viewers

#### 2. Members Tab (`MyGroupMembersTab`)
- User search via scoped endpoint (`/groups/:id/users/search`)
- Same member management as admin tab (add, role change, remove)
- Restricted to group admins; members and viewers see read-only list

### API Keys Integration

When a user creates an API key:
- Optional **Group** dropdown appears if the user belongs to any groups
- Selecting a group restricts the model selection to the group's `allowedModels`
- Group-allowed models **bypass individual subscription requirements**
- After creation, the Group field is read-only (cannot change group association)
- The "Group" column in the API keys table shows the team name or "Personal"

---

## API Endpoints

### Admin Group Management (`/api/v1/admin/groups`)

| Method   | Path                                       | Permission            | Description                          |
| -------- | ------------------------------------------ | --------------------- | ------------------------------------ |
| `GET`    | `/api/v1/admin/groups`                     | `admin:groups:read`   | List all groups (paginated, search, status filter) |
| `POST`   | `/api/v1/admin/groups`                     | `admin:groups:write`  | Create group                         |
| `GET`    | `/api/v1/admin/groups/:groupId`            | `admin:groups:read`   | Get group details with members       |
| `PATCH`  | `/api/v1/admin/groups/:groupId`            | `admin:groups:write`  | Update group settings                |
| `DELETE` | `/api/v1/admin/groups/:groupId`            | `admin:groups:write`  | Soft-delete group                    |
| `POST`   | `/api/v1/admin/groups/:groupId/members`    | `admin:groups:write`  | Add member to group                  |
| `PATCH`  | `/api/v1/admin/groups/:groupId/members/:userId` | `admin:groups:write` | Update member role              |
| `DELETE` | `/api/v1/admin/groups/:groupId/members/:userId` | `admin:groups:write` | Remove member from group        |
| `GET`    | `/api/v1/admin/groups/:groupId/budget`     | `admin:groups:read`   | Get budget utilization info          |

### User Group Endpoints (`/api/v1/groups`)

| Method   | Path                                       | Access Control        | Description                          |
| -------- | ------------------------------------------ | --------------------- | ------------------------------------ |
| `GET`    | `/api/v1/groups`                           | Authenticated         | List user's groups                   |
| `GET`    | `/api/v1/groups/:groupId`                  | Team member           | Get group details                    |
| `PATCH`  | `/api/v1/groups/:groupId`                  | Team admin            | Update name/alias/description        |
| `GET`    | `/api/v1/groups/:groupId/users/search`     | Team admin            | Search users to add (excludes existing members) |
| `POST`   | `/api/v1/groups/:groupId/members`          | Team admin            | Add member                           |
| `PATCH`  | `/api/v1/groups/:groupId/members/:userId`  | Team admin            | Update member role                   |
| `DELETE` | `/api/v1/groups/:groupId/members/:userId`  | Team admin            | Remove member                        |
| `GET`    | `/api/v1/groups/:groupId/budget`           | Team member           | Get budget utilization               |

### Request/Response Examples

#### Create Group

```json
POST /api/v1/admin/groups

Request:
{
  "name": "Data Science Team",
  "alias": "DS",
  "description": "Data science and ML engineering team",
  "maxBudget": 500.00,
  "budgetDuration": "monthly",
  "tpmLimit": 50000,
  "rpmLimit": 500,
  "allowedModels": ["gpt-4", "claude-3-opus"],
  "adminIds": ["user-uuid-1", "user-uuid-2"]
}

Response (201):
{
  "id": "group-uuid",
  "name": "Data Science Team",
  "alias": "DS",
  "description": "Data science and ML engineering team",
  "maxBudget": 500.00,
  "currentSpend": 0.00,
  "budgetDuration": "monthly",
  "tpmLimit": 50000,
  "rpmLimit": 500,
  "allowedModels": ["gpt-4", "claude-3-opus"],
  "memberCount": 3,
  "isActive": true,
  "createdAt": "2026-03-10T10:00:00Z",
  "updatedAt": "2026-03-10T10:00:00Z"
}
```

#### List Groups (Admin)

```json
GET /api/v1/admin/groups?page=1&limit=20&search=data&isActive=true

Response:
{
  "data": [ /* GroupSchema items */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 5,
    "totalPages": 1
  }
}
```

#### Get Group Details

```json
GET /api/v1/admin/groups/:groupId

Response:
{
  "id": "group-uuid",
  "name": "Data Science Team",
  "alias": "DS",
  "description": "...",
  "maxBudget": 500.00,
  "currentSpend": 125.50,
  "members": [
    {
      "id": "member-uuid",
      "userId": "user-uuid",
      "role": "admin",
      "joinedAt": "2026-03-10T10:00:00Z",
      "user": {
        "id": "user-uuid",
        "username": "jdoe",
        "email": "jdoe@example.com",
        "fullName": "Jane Doe"
      }
    }
  ]
}
```

#### Get Budget Info

```json
GET /api/v1/admin/groups/:groupId/budget

Response:
{
  "teamId": "group-uuid",
  "maxBudget": 500.00,
  "currentSpend": 125.50,
  "budgetUtilization": 25.1,
  "remainingBudget": 374.50,
  "budgetDuration": "monthly",
  "memberCount": 5,
  "lastUpdatedAt": "2026-03-10T12:00:00Z"
}
```

#### Add Member

```json
POST /api/v1/admin/groups/:groupId/members

Request:
{
  "userId": "user-uuid",
  "role": "member"
}

Response (201):
{
  "message": "Member added successfully"
}
```

---

## Service Layer — TeamService

The `TeamService` extends `BaseService` and handles all group business logic.

### Key Operations

**Group Lifecycle**:
1. `createTeam()` — Validates name uniqueness, creates LiteLLM team, inserts DB record, adds creator + additional admins, writes audit log
2. `updateTeam()` — Validates admin access (unless `skipAccessCheck`), updates DB, syncs to LiteLLM, cascades model removals to API keys
3. `deleteTeam()` — Blocks if active subscriptions exist, soft-deletes, removes from LiteLLM

**Member Management**:
1. `addTeamMember()` — Validates access, checks duplicates, verifies user exists, inserts into DB, syncs non-viewers to LiteLLM
2. `removeTeamMember()` — Prevents removing last admin, deletes from DB, syncs removal to LiteLLM
3. `updateTeamMemberRole()` — Prevents demoting last admin, smart LiteLLM sync based on role transitions

**Access Control**:
- `checkTeamAccess(teamId, userId, requiredRole)` — Role hierarchy: `viewer(0) < member(1) < admin(2)`
- Admin routes pass `skipAccessCheck=true`; user routes enforce membership

### Model Removal Cascade

When models are removed from a group's `allowedModels`:

1. Service snapshots previous `allowedModels` before update
2. Computes removed model IDs
3. Calls `ApiKeyService.removeModelsFromTeamApiKeys(teamId, removedModelIds)`
4. For each active API key in the team with affected models:
   - Updates LiteLLM key first (removes models from key's `models` array)
   - Only after successful LiteLLM update, removes from `api_key_models` in PostgreSQL
5. Keys that fail LiteLLM update are skipped (LiteLLM-first safety)

### Viewer Role Handling

The `viewer` role exists only in the LiteMaaS database — viewers are **never** synced to LiteLLM. This means:
- Viewers can see group information in the UI
- Viewers cannot create API keys linked to the group (they aren't in the LiteLLM team)
- Role transitions to/from `viewer` trigger add/remove in LiteLLM accordingly

---

## LiteLLM Integration

Groups synchronize with LiteLLM's team system for budget enforcement and model access control.

| Operation                | LiteLLM Endpoint           | Notes                                  |
| ------------------------ | -------------------------- | -------------------------------------- |
| Create team              | `POST /team/new`           | Sets alias, budget, models, admins     |
| Get team info            | `GET /team/info?team_id=`  | Real-time budget/spend retrieval       |
| Update team              | `POST /team/update`        | Syncs settings changes                 |
| Delete team              | `POST /team/delete`        | Deletes by ID array                    |
| Add member               | `POST /team/member_add`    | Only for non-viewer roles              |
| Remove member            | `POST /team/member_delete` | Only for non-viewer roles              |
| Update member            | `POST /team/member_update` | Role change for non-viewer transitions |

**Role mapping**: LiteMaaS `admin` → LiteLLM `admin`, LiteMaaS `member` → LiteLLM `user`

**Error handling**: LiteLLM sync errors are logged as warnings but do not fail the primary operation (best-effort sync pattern). Mock mode supported via `config.enableMocking`.

**API Key scoping**: Keys created with a `teamId` pass `team_id` to LiteLLM's `/key/generate`, scoping the key to the LiteLLM team's budget and model restrictions.

---

## Audit Trail

All group management actions are logged to the `audit_logs` table.

| Action                      | Details Logged                                          |
| --------------------------- | ------------------------------------------------------- |
| `TEAM_CREATE`               | Admin ID, team name, settings                           |
| `TEAM_UPDATE`               | Admin ID, team ID, changed fields                       |
| `TEAM_DELETE`               | Admin ID, team ID                                       |
| `TEAM_MEMBER_ADD`           | Admin ID, team ID, added user ID, role                  |
| `TEAM_MEMBER_REMOVE`        | Admin ID, team ID, removed user ID                      |
| `TEAM_MEMBER_ROLE_UPDATE`   | Admin ID, team ID, user ID, old role, new role          |

---

## Default Team

A system-created Default Team with fixed UUID `a0000000-0000-4000-8000-000000000001` is automatically created during database migration:

- All existing users are assigned as `member` role
- New users are assigned to the Default Team during registration
- The Default Team is **filtered out** from both admin and user group list responses
- Its empty `allowed_models` array grants access to **all** models (special default team behavior)
- It cannot be deleted or deactivated through the UI

---

## Typical Workflows

### Admin: Creating a Project Group

1. Navigate to **Admin → Group Management**
2. Click **Create Group**
3. **Details tab**: Enter name, optional alias and description
4. **Models tab**: Select which models the group should have access to
5. **Members tab**: Search and add users with appropriate roles (admin/member/viewer)
6. **Budget tab**: Set max budget, duration, and rate limits
7. Click **Save** — group is created in both LiteMaaS and LiteLLM

### User: Creating a Group API Key

1. Navigate to **API Keys**
2. Click **Create API Key**
3. In the **Group** dropdown, select the target group
4. Model selection updates to show only the group's allowed models
5. Select models, set name and any quotas
6. Click **Create** — key is scoped to the group's LiteLLM team
7. Copy the generated key

### Admin: Adjusting Group Model Access

1. Open the group in **Group Management**
2. Go to the **Models tab**
3. Uncheck models that should no longer be accessible
4. Click **Save**
5. System automatically removes the unchecked models from all API keys in the group
6. LiteLLM keys are updated first; local database updated only after successful LiteLLM sync

### Group Admin: Managing Members

1. Navigate to **My Groups** and click on a group where you are an admin
2. Go to the **Members tab**
3. Use the search bar to find users by username or email
4. Select a role and click **Add**
5. To change a role: use the role dropdown on the member row
6. To remove: click the remove action (cannot remove the last admin)

---

## Related Documentation

- [User Roles & Administration](user-roles-administration.md) — RBAC system details
- [Users Management](users-management.md) — Admin user management guide
- [REST API Reference](../api/rest-api.md#groups-apiv1groups) — Complete API endpoint documentation
- [Database Schema](../architecture/database-schema.md) — Table definitions
