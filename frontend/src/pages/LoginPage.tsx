import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  LoginPage as PFLoginPage,
  Stack,
  StackItem,
  Divider,
  Spinner,
  Dropdown,
  DropdownItem,
  DropdownList,
  MenuToggle,
  TextInput,
  Menu,
  MenuContent,
  MenuList,
  MenuItem,
  Label,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { ExternalLinkAltIcon, UserIcon, GlobeIcon, SearchIcon } from '@patternfly/react-icons';
import { Octobean } from '../assets';
import { useAuth } from '../contexts/AuthContext';
import { useBranding } from '../contexts/BrandingContext';
import { brandingService } from '../services/branding.service';
import { configService } from '../services/config.service';

interface DevUser {
  id: string;
  username: string;
  email: string;
  name: string;
  roles: string[];
}

const LoginPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { login, loginAsAdmin, loginAsUser } = useAuth();
  const { brandingSettings } = useBranding();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionExpired = searchParams.get('session') === 'expired';
  const [authMode, setAuthMode] = useState<'oauth' | 'mock' | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState(false);
  const [isLanguageDropdownOpen, setIsLanguageDropdownOpen] = useState(false);

  // Compute branding overrides
  const brandImgSrc =
    brandingSettings?.loginLogoEnabled && brandingSettings?.hasLoginLogo
      ? brandingService.getImageUrl('login-logo')
      : Octobean;

  const loginPageTitle =
    brandingSettings?.loginTitleEnabled && brandingSettings?.loginTitle
      ? brandingSettings.loginTitle
      : t('pages.login.title');

  const loginPageSubtitle =
    brandingSettings?.loginSubtitleEnabled && brandingSettings?.loginSubtitle
      ? brandingSettings.loginSubtitle
      : t('pages.login.subtitle');

  // Dev user search state
  const [userSearch, setUserSearch] = useState('');
  const [searchResults, setSearchResults] = useState<DevUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedUser, setSelectedUser] = useState<DevUser | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const searchUsers = useCallback(async (query: string) => {
    setIsSearching(true);
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (query.trim()) {
        params.set('search', query.trim());
      }
      const response = await fetch(`/api/auth/dev-users?${params}`);
      if (response.ok) {
        const data = await response.json();
        setSearchResults(data.users || []);
        setShowResults(true);
      }
    } catch (error) {
      console.error('Failed to search users:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleSearchChange = useCallback((_event: React.FormEvent<HTMLInputElement>, value: string) => {
    setUserSearch(value);
    setSelectedUser(null);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      searchUsers(value);
    }, 300);
  }, [searchUsers]);

  const handleUserSelect = useCallback((user: DevUser) => {
    setSelectedUser(user);
    setUserSearch(user.username);
    setShowResults(false);
  }, []);

  const handleLoginAsUser = useCallback(() => {
    if (selectedUser) {
      loginAsUser(selectedUser);
    }
  }, [selectedUser, loginAsUser]);

  const handleSearchFocus = useCallback(() => {
    if (searchResults.length > 0) {
      setShowResults(true);
    } else {
      searchUsers(userSearch);
    }
  }, [searchResults.length, searchUsers, userSearch]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  const handleLogin = () => {
    login();
  };

  const handleLanguageChange = (language: string) => {
    i18n.changeLanguage(language);
    setIsLanguageDropdownOpen(false);
  };

  const languageDropdownItems = (
    <DropdownList>
      <DropdownItem key="en" onClick={() => handleLanguageChange('en')}>
        🇺🇸 {t('ui.language.english')}
      </DropdownItem>
      <DropdownItem key="es" onClick={() => handleLanguageChange('es')}>
        🇪🇸 {t('ui.language.spanish')}
      </DropdownItem>
      <DropdownItem key="fr" onClick={() => handleLanguageChange('fr')}>
        🇫🇷 {t('ui.language.french')}
      </DropdownItem>
      <DropdownItem key="de" onClick={() => handleLanguageChange('de')}>
        🇩🇪 {t('ui.language.german')}
      </DropdownItem>
      <DropdownItem key="it" onClick={() => handleLanguageChange('it')}>
        🇮🇹 {t('ui.language.italian')}
      </DropdownItem>
      <DropdownItem key="ko" onClick={() => handleLanguageChange('ko')}>
        🇰🇷 {t('ui.language.korean')}
      </DropdownItem>
      <DropdownItem key="ja" onClick={() => handleLanguageChange('ja')}>
        🇯🇵 {t('ui.language.japanese')}
      </DropdownItem>
      <DropdownItem key="zh" onClick={() => handleLanguageChange('zh')}>
        🇨🇳 {t('ui.language.chinese')}
      </DropdownItem>
      <DropdownItem key="elv" onClick={() => handleLanguageChange('elv')}>
        🧝‍♂️ {t('ui.language.elvish')}
      </DropdownItem>
    </DropdownList>
  );

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const config = await configService.getConfig();
        setAuthMode(config.authMode ?? 'oauth');
      } catch (err) {
        console.error('Failed to load configuration:', err);
        setConfigError(true);
        // Default to oauth mode on error
        setAuthMode('oauth');
      } finally {
        setConfigLoading(false);
      }
    };

    loadConfig();
  }, []);

  useEffect(() => {
    if (sessionExpired) {
      setSearchParams({}, { replace: true });
    }
  }, [sessionExpired, setSearchParams]);

  return (
    <PFLoginPage
      brandImgSrc={brandImgSrc}
      brandImgAlt={t('pages.login.brandAlt')}
      backgroundImgSrc="/bg.jpg"
      loginTitle={loginPageTitle}
      loginSubtitle={loginPageSubtitle}
    >
      <Stack hasGutter>
        {sessionExpired && (
          <StackItem>
            <Alert variant="warning" title={t('pages.login.sessionExpired')} isInline />
          </StackItem>
        )}
        {configError && (
          <StackItem>
            <Alert variant="danger" title={t('pages.login.configError')} isInline />
          </StackItem>
        )}
        <StackItem>
          <Button
            variant="primary"
            onClick={handleLogin}
            isBlock
            icon={<ExternalLinkAltIcon />}
            iconPosition="end"
          >
            {t('pages.login.loginWithOpenShift')}
          </Button>
        </StackItem>

        <StackItem>
          <div className="pf-v6-u-text-align-center pf-v6-u-mt-md">
            <Dropdown
              isOpen={isLanguageDropdownOpen}
              onSelect={() => setIsLanguageDropdownOpen(false)}
              onOpenChange={setIsLanguageDropdownOpen}
              toggle={(toggleRef) => (
                <MenuToggle
                  ref={toggleRef}
                  aria-label={t('ui.language.selector')}
                  variant="plain"
                  onClick={() => setIsLanguageDropdownOpen(!isLanguageDropdownOpen)}
                  icon={<GlobeIcon />}
                >
                  {t('ui.language.selector')}
                </MenuToggle>
              )}
            >
              {languageDropdownItems}
            </Dropdown>
          </div>
        </StackItem>

        {configLoading ? (
          <StackItem>
            <div className="pf-v6-u-text-align-center">
              <Spinner size="md" />
            </div>
          </StackItem>
        ) : authMode === 'mock' ? (
          <>
            <StackItem>
              <div className="pf-v6-u-text-align-center pf-v6-u-my-md">
                <Divider />
                <div className="pf-v6-u-mt-sm">
                  <small className="pf-v6-u-color-400">{t('pages.login.developmentMode')}</small>
                </div>
              </div>
            </StackItem>

            <StackItem>
              <Button
                variant="secondary"
                onClick={loginAsAdmin}
                isBlock
                icon={<UserIcon />}
                iconPosition="start"
              >
                {t('pages.login.loginAsAdmin')}
              </Button>
              <div className="pf-v6-u-text-align-center pf-v6-u-mt-sm">
                <small className="pf-v6-u-color-400">{t('pages.login.bypassAuthentication')}</small>
              </div>
            </StackItem>

            <StackItem>
              <div className="pf-v6-u-text-align-center pf-v6-u-my-sm">
                <Divider />
                <div className="pf-v6-u-mt-sm">
                  <small className="pf-v6-u-color-400">{t('pages.login.loginAsUserDescription')}</small>
                </div>
              </div>
            </StackItem>

            <StackItem>
              <div ref={searchContainerRef} style={{ position: 'relative' }}>
                <TextInput
                  type="text"
                  id="dev-user-search"
                  aria-label={t('pages.login.searchUsers')}
                  placeholder={t('pages.login.searchUsersPlaceholder')}
                  value={userSearch}
                  onChange={handleSearchChange}
                  onFocus={handleSearchFocus}
                  customIcon={isSearching ? <Spinner size="sm" /> : <SearchIcon />}
                />
                {showResults && searchResults.length > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      zIndex: 1000,
                      width: '100%',
                      maxHeight: '250px',
                      overflowY: 'auto',
                      background: 'var(--pf-t--global--background--color--primary--default)',
                      border: '1px solid var(--pf-t--global--border--color--default)',
                      borderRadius: 'var(--pf-t--global--border--radius--small)',
                      boxShadow: 'var(--pf-t--global--box-shadow--md)',
                    }}
                  >
                    <Menu isPlain isScrollable>
                      <MenuContent>
                        <MenuList>
                          {searchResults.map((user) => (
                            <MenuItem
                              key={user.id}
                              onClick={() => handleUserSelect(user)}
                              isSelected={selectedUser?.id === user.id}
                              description={user.email}
                            >
                              <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
                                <FlexItem>{user.username}</FlexItem>
                                {user.roles.map((role) => (
                                  <FlexItem key={role}>
                                    <Label
                                      isCompact
                                      color={role === 'admin' ? 'red' : role === 'adminReadonly' ? 'orange' : 'blue'}
                                    >
                                      {role}
                                    </Label>
                                  </FlexItem>
                                ))}
                              </Flex>
                            </MenuItem>
                          ))}
                        </MenuList>
                      </MenuContent>
                    </Menu>
                  </div>
                )}
                {showResults && !isSearching && searchResults.length === 0 && userSearch.trim() && (
                  <div
                    style={{
                      position: 'absolute',
                      zIndex: 1000,
                      width: '100%',
                      padding: '12px',
                      textAlign: 'center',
                      background: 'var(--pf-t--global--background--color--primary--default)',
                      border: '1px solid var(--pf-t--global--border--color--default)',
                      borderRadius: 'var(--pf-t--global--border--radius--small)',
                    }}
                  >
                    <small className="pf-v6-u-color-400">{t('pages.login.noUsersFound')}</small>
                  </div>
                )}
              </div>
            </StackItem>

            <StackItem>
              <Button
                variant="tertiary"
                onClick={handleLoginAsUser}
                isBlock
                isDisabled={!selectedUser}
                icon={<SearchIcon />}
                iconPosition="start"
              >
                {selectedUser
                  ? t('pages.login.loginAsUser', { username: selectedUser.username })
                  : t('pages.login.selectUserToLogin')}
              </Button>
            </StackItem>
          </>
        ) : null}
      </Stack>
    </PFLoginPage>
  );
};

export default LoginPage;
