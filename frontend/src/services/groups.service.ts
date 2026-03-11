import { apiClient } from './api';
import {
  GroupWithMembers,
  CreateGroupRequest,
  UpdateGroupRequest,
  UpdateGroupDetailsRequest,
  AddGroupMemberRequest,
  UpdateGroupMemberRoleRequest,
  GroupListParams,
  GroupBudgetInfo,
  GroupMember,
  GroupUserSearchResult,
  PaginatedGroupResponse,
} from '../types/groups';

export class GroupsService {
  // ============================================
  // Admin Methods
  // ============================================

  /**
   * Get paginated list of all groups (admin only)
   * Requires admin or admin-readonly role
   */
  async getAdminGroups(params: GroupListParams = {}): Promise<PaginatedGroupResponse> {
    const searchParams = new URLSearchParams();

    if (params.page) {
      searchParams.append('page', params.page.toString());
    }
    if (params.limit) {
      searchParams.append('limit', params.limit.toString());
    }
    if (params.search) {
      searchParams.append('search', params.search);
    }
    if (typeof params.isActive === 'boolean') {
      searchParams.append('isActive', params.isActive.toString());
    }

    const queryString = searchParams.toString();
    const url = queryString ? `/admin/groups?${queryString}` : '/admin/groups';

    return apiClient.get<PaginatedGroupResponse>(url);
  }

  /**
   * Create a new group (admin only)
   * Requires admin role
   */
  async createGroup(data: CreateGroupRequest): Promise<GroupWithMembers> {
    return apiClient.post<GroupWithMembers>('/admin/groups', data);
  }

  /**
   * Get detailed group information including members (admin only)
   * Requires admin or admin-readonly role
   */
  async getAdminGroupDetails(groupId: string): Promise<GroupWithMembers> {
    return apiClient.get<GroupWithMembers>(`/admin/groups/${groupId}`);
  }

  /**
   * Update group settings (admin only)
   * Requires admin role
   */
  async updateGroup(groupId: string, data: UpdateGroupRequest): Promise<GroupWithMembers> {
    return apiClient.patch<GroupWithMembers>(`/admin/groups/${groupId}`, data);
  }

  /**
   * Delete a group (admin only)
   * Requires admin role
   */
  async deleteGroup(groupId: string): Promise<void> {
    await apiClient.delete(`/admin/groups/${groupId}`);
  }

  /**
   * Add a member to a group (admin only)
   * Requires admin role
   */
  async addMember(groupId: string, data: AddGroupMemberRequest): Promise<GroupMember> {
    return apiClient.post<GroupMember>(`/admin/groups/${groupId}/members`, data);
  }

  /**
   * Update a member's role within a group (admin only)
   * Requires admin role
   */
  async updateMemberRole(
    groupId: string,
    userId: string,
    data: UpdateGroupMemberRoleRequest,
  ): Promise<GroupMember> {
    return apiClient.patch<GroupMember>(`/admin/groups/${groupId}/members/${userId}`, data);
  }

  /**
   * Remove a member from a group (admin only)
   * Requires admin role
   */
  async removeMember(groupId: string, userId: string): Promise<void> {
    await apiClient.delete(`/admin/groups/${groupId}/members/${userId}`);
  }

  /**
   * Get group budget information (admin only)
   * Requires admin or admin-readonly role
   */
  async getGroupBudget(groupId: string): Promise<GroupBudgetInfo> {
    return apiClient.get<GroupBudgetInfo>(`/admin/groups/${groupId}/budget`);
  }

  // ============================================
  // User Methods
  // ============================================

  /**
   * Get paginated list of groups the current user belongs to
   */
  async getMyGroups(params: GroupListParams = {}): Promise<PaginatedGroupResponse> {
    const searchParams = new URLSearchParams();

    if (params.page) {
      searchParams.append('page', params.page.toString());
    }
    if (params.limit) {
      searchParams.append('limit', params.limit.toString());
    }
    if (params.search) {
      searchParams.append('search', params.search);
    }
    if (params.isActive !== undefined) {
      searchParams.append('isActive', params.isActive.toString());
    }

    const queryString = searchParams.toString();
    const url = queryString ? `/groups?${queryString}` : '/groups';

    return apiClient.get<PaginatedGroupResponse>(url);
  }

  /**
   * Get detailed group information including members
   * User must be a member of the group
   */
  async getGroupDetails(groupId: string): Promise<GroupWithMembers> {
    return apiClient.get<GroupWithMembers>(`/groups/${groupId}`);
  }

  /**
   * Invite a member to a group
   * User must be a group admin
   */
  async inviteMember(groupId: string, data: AddGroupMemberRequest): Promise<GroupMember> {
    return apiClient.post<GroupMember>(`/groups/${groupId}/members`, data);
  }

  /**
   * Update a member's role within a group
   * User must be a group admin
   */
  async updateGroupMemberRole(
    groupId: string,
    userId: string,
    data: UpdateGroupMemberRoleRequest,
  ): Promise<GroupMember> {
    return apiClient.patch<GroupMember>(`/groups/${groupId}/members/${userId}`, data);
  }

  /**
   * Remove a member from a group
   * User must be a group admin
   */
  async removeGroupMember(groupId: string, userId: string): Promise<void> {
    await apiClient.delete(`/groups/${groupId}/members/${userId}`);
  }

  /**
   * Update group details (name, alias, description)
   * User must be a group admin
   */
  async updateMyGroupDetails(
    groupId: string,
    data: UpdateGroupDetailsRequest,
  ): Promise<GroupWithMembers> {
    return apiClient.patch<GroupWithMembers>(`/groups/${groupId}`, data);
  }

  /**
   * Search for users to add to a group
   * User must be a group admin. Returns users not already in the group.
   */
  async searchGroupUsers(
    groupId: string,
    search: string,
    limit = 10,
  ): Promise<GroupUserSearchResult> {
    const params = new URLSearchParams({ search });
    if (limit !== 10) {
      params.append('limit', limit.toString());
    }
    return apiClient.get<GroupUserSearchResult>(
      `/groups/${groupId}/users/search?${params.toString()}`,
    );
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Check if the current user can manage groups (admin permissions)
   * This is a client-side helper to determine UI visibility
   */
  canManageGroups(currentUser?: { roles: string[] }): boolean {
    if (!currentUser?.roles) {
      return false;
    }

    return currentUser.roles.includes('admin');
  }

  /**
   * Check if the current user can view groups (admin or admin-readonly)
   * This is a client-side helper to determine UI visibility
   */
  canViewGroups(currentUser?: { roles: string[] }): boolean {
    if (!currentUser?.roles) {
      return false;
    }

    return currentUser.roles.includes('admin') || currentUser.roles.includes('admin-readonly');
  }
}

// Export singleton instance
export const groupsService = new GroupsService();
