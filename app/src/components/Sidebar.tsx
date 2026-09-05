import { NavLink, useNavigate } from 'react-router-dom';
import { 
  Video, 
  LayoutDashboard, 
  Wallet, 
  CreditCard, 
  X,
  LogOut,
  Menu,
  Settings,
  ShieldCheck
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

const userNavItems: NavItem[] = [
  { path: ROUTES.PROTECTED.DASHBOARD, label: 'Dashboard', icon: LayoutDashboard },
  { path: ROUTES.PROTECTED.WALLET, label: 'Wallet', icon: Wallet },
  { path: ROUTES.PROTECTED.SUBSCRIPTION, label: 'Subscription', icon: CreditCard },
  { path: ROUTES.PROTECTED.SETTINGS, label: 'Settings', icon: Settings },
];

const adminNavItems: NavItem[] = [
  { path: ROUTES.PROTECTED.ADMIN, label: 'Admin Dashboard', icon: ShieldCheck },
];

export default function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useUI();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const navItems = user?.isAdmin ? adminNavItems : userNavItems;

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
      {/* Sticky Hamburger Toggle (When Closed) */}
      {!sidebarOpen && (
        <button
          onClick={toggleSidebar}
          aria-label="Open sidebar"
          title="Open sidebar"
          className="fixed top-5 left-5 z-50 p-2.5 bg-background border border-border rounded-xl hover:bg-background hover:scale-105 shadow-xl transition-all duration-300"
        >
          <Menu className="w-5 h-5 text-foreground" />
        </button>
      )}

      {/* Main Sidebar Element */}
      <aside
        className={`fixed left-0 top-0 h-screen bg-background border-r border-border transition-transform duration-300 ease-in-out z-50 flex flex-col w-56 shadow-2xl ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-20 flex items-center justify-between px-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary flex items-center justify-center shadow-lg shadow-black/5">
              <Video className="w-4 h-4 text-primary-foreground" />
            </div>
            <div>
              <span className="text-lg font-bold text-foreground tracking-tight">Morphly</span>
              <p className="text-[10px] text-muted-foreground -mt-0.5 tracking-wide uppercase font-semibold">AI Streaming</p>
            </div>
          </div>
          <button 
            onClick={toggleSidebar} 
            aria-label="Close sidebar"
            title="Close sidebar"
            className="p-1.5 hover:bg-background rounded-lg text-muted-foreground hover:text-foreground transition-all transform hover:rotate-90"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 py-8 px-4 space-y-1.5 overflow-y-auto custom-scrollbar">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={() => {
                // Auto close on mobile when navigating
                if (window.innerWidth < 1024) toggleSidebar();
              }}
              className={({ isActive }) =>
                `flex items-center gap-3.5 px-4 py-3.5 rounded-xl transition-all duration-200 group relative overflow-hidden ${
                  isActive
                    ? 'bg-accent text-foreground border border-primary/20 shadow-lg shadow-black/5'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background border border-transparent hover:border-border'
                }`
              }
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              <span className="font-medium text-sm tracking-wide">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="p-5 border-t border-border bg-background">
            <div className="flex items-center gap-3 mb-4 p-2.5 rounded-xl bg-background border border-border shadow-inner">
              <Avatar className="w-10 h-10 ring-2 ring-ring">
                <AvatarFallback className="bg-gradient-to-br from-accent to-background text-xs font-semibold text-foreground">
                  {user?.name ? getInitials(user.name) : 'JD'}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">
                  {user?.name || 'Jane Doe'}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {user?.email || 'jane@example.com'}
                </p>
              </div>
            </div>
            <Button
              onClick={handleLogout}
              variant="ghost"
              className="w-full justify-start gap-3 h-11 text-muted-foreground hover:text-foreground hover:bg-danger-soft hover:border-destructive/20 border border-transparent transition-all"
            >
              <LogOut className="w-4 h-4" />
              <span className="text-sm font-medium">Securely Sign out</span>
            </Button>
        </div>
      </aside>

      {/* Mobile Backdrop Overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden transition-opacity duration-300"
          onClick={toggleSidebar}
        />
      )}
    </>
  );
}
