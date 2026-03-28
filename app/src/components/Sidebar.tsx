import { NavLink, useNavigate } from 'react-router-dom';
import { 
  Video, 
  LayoutDashboard, 
  Wallet, 
  CreditCard, 
  ChevronLeft, 
  ChevronRight,
  LogOut,
  Menu,
  Settings
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useUI } from '@/context/UIContext';
import { useAuth } from '@/context/AuthContext';
import { ROUTES } from '@/lib/routes';

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { path: ROUTES.PROTECTED.DASHBOARD, label: 'Dashboard', icon: LayoutDashboard },
  { path: ROUTES.PROTECTED.WALLET, label: 'Wallet', icon: Wallet },
  { path: ROUTES.PROTECTED.SUBSCRIPTION, label: 'Subscription', icon: CreditCard },
  { path: ROUTES.PROTECTED.SETTINGS, label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const { sidebarOpen, toggleSidebar, toggleSidebarCollapse, sidebarCollapsed } = useUI();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <>
      {!sidebarOpen && (
        <button
          onClick={toggleSidebar}
          className="fixed top-4 left-4 z-50 p-2 bg-[#18181b] border border-[#27272a] rounded-lg hover:bg-[#27272a] transition-colors lg:hidden"
        >
          <Menu className="w-5 h-5 text-white" />
        </button>
      )}

      <aside
        className={`fixed left-0 top-0 h-screen bg-[#0f0f10] border-r border-[#18181b] transition-all duration-300 z-40 flex flex-col ${
          sidebarOpen ? 'w-64' : 'w-20'
        } ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'}`}
      >
        <div className="h-16 flex items-center justify-between px-4 border-b border-[#18181b]">
          {sidebarOpen ? (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                <Video className="w-4 h-4 text-white" />
              </div>
              <div>
                <span className="text-lg font-bold text-white tracking-tight">Morphly</span>
                <p className="text-[10px] text-[#71717a] -mt-0.5 tracking-wide">AI Streaming</p>
              </div>
            </div>
          ) : (
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center mx-auto">
              <Video className="w-4 h-4 text-white" />
            </div>
          )}
        </div>

        <nav className="flex-1 py-6 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group ${
                  isActive
                    ? 'bg-blue-500/10 text-white border border-blue-500/20 shadow-lg shadow-blue-500/5'
                    : 'text-[#a1a1aa] hover:text-white hover:bg-[#18181b] border border-transparent hover:border-[#27272a]'
                } ${!sidebarOpen && 'justify-center'}`
              }
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              {sidebarOpen && (
                <span className="font-medium text-sm">{item.label}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-[#18181b]">
          {sidebarOpen ? (
            <>
              <div className="flex items-center gap-3 mb-4 p-2 rounded-xl bg-[#18181b] border border-[#27272a]">
                <Avatar className="w-9 h-9 ring-2 ring-[#27272a]">
                  <AvatarFallback className="bg-gradient-to-br from-blue-500/20 to-[#18181b] text-xs font-semibold text-white">
                    {user?.name ? getInitials(user.name) : 'JD'}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">
                    {user?.name || 'Jane Doe'}
                  </p>
                  <p className="text-xs text-[#71717a] truncate">
                    {user?.email || 'jane@example.com'}
                  </p>
                </div>
              </div>
              <Button
                onClick={handleLogout}
                variant="ghost"
                className="w-full justify-start gap-3 text-[#a1a1aa] hover:text-white hover:bg-red-500/10 hover:text-red-400 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span className="text-sm font-medium">Sign out</span>
              </Button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <Avatar className="w-9 h-9 ring-2 ring-[#27272a]">
                <AvatarFallback className="bg-gradient-to-br from-blue-500/20 to-[#18181b] text-xs font-semibold text-white">
                  {user?.name ? getInitials(user.name) : 'JD'}
                </AvatarFallback>
              </Avatar>
              <Button
                onClick={handleLogout}
                variant="ghost"
                size="sm"
                className="p-2 text-[#a1a1aa] hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-[#18181b]">
          <Button
            onClick={sidebarCollapsed ? toggleSidebar : toggleSidebarCollapse}
            variant="ghost"
            size="sm"
            className="w-full justify-center text-[#71717a] hover:text-white hover:bg-[#18181b] transition-colors"
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </Button>
        </div>
      </aside>

      {!sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={toggleSidebar}
        />
      )}
    </>
  );
}
