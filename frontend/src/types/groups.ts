export interface Group {
  id: string;
  name: string;
  alias?: string;
  description?: string;
  maxBudget?: number;
  currentSpend?: number;
  budgetDuration?: string;
  tpmLimit?: number;
  rpmLimit?: number;
  allowedModels?: string[];
  memberCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  myRole?: 'admin' | 'member' | 'viewer';
}

export interface GroupMember {
  id: string;
  userId: string;
  role: 'admin' | 'member' | 'viewer';
  joinedAt: string;
  user: {
    id: string;
    username: string;
    email: string;
    fullName?: string;
  };
}

export interface GroupWithMembers extends Group {
  members: GroupMember[];
}

export interface CreateGroupRequest {
  name: string;
  alias?: string;
  description?: string;
  maxBudget?: number;
  budgetDuration?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  tpmLimit?: number;
  rpmLimit?: number;
  allowedModels?: string[];
  adminIds?: string[];
}

export interface UpdateGroupRequest {
  name?: string;
  alias?: string;
  description?: string;
  maxBudget?: number;
  budgetDuration?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  tpmLimit?: number;
  rpmLimit?: number;
  allowedModels?: string[];
  isActive?: boolean;
}

export interface AddGroupMemberRequest {
  userId: string;
  role?: 'admin' | 'member' | 'viewer';
}

export interface UpdateGroupMemberRoleRequest {
  role: 'admin' | 'member' | 'viewer';
}

/** Limited update request for group admins (non-RBAC) */
export interface UpdateGroupDetailsRequest {
  name?: string;
  alias?: string;
  description?: string;
}

/** Search result for users in group context */
export interface GroupUserSearchResult {
  users: Array<{
    userId: string;
    username: string;
    email: string;
  }>;
  total: number;
}

export interface GroupListParams {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface GroupBudgetInfo {
  teamId: string;
  maxBudget?: number;
  currentSpend: number;
  budgetUtilization: number;
  remainingBudget?: number;
  budgetDuration?: string;
  memberCount: number;
  lastUpdatedAt: string;
}

export interface PaginatedGroupResponse {
  data: Group[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
