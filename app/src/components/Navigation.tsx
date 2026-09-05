import { NavLink } from 'react-router-dom';
import { Video, ChevronDown, LogOut, Coins, Wallet, LayoutDashboard, Settings } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { ROUTES } from '@/lib/routes';

interface NavigationProps {
  children: React.ReactNode;
}

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function Navigation({ children }: NavigationProps) {
  const { user, logout } = useAuth();
  const { credits, sessionStatus } = useApp();

  const navItems: NavItem[] = [
    { path: ROUTES.PROTECTED.DASHBOARD, label: 'Dashboard', icon: LayoutDashboard },
    { path: ROUTES.PROTECTED.WALLET, label: 'Wallet', icon: Wallet },
    { path: ROUTES.PROTECTED.SUBSCRIPTION, label: 'Buy Credits', icon: Coins },
    { path: ROUTES.PROTECTED.SETTINGS, label: 'Settings', icon: Settings },
  ];

  const getNavLinkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 text-sm font-medium transition-all duration-200 rounded-lg flex items-center gap-1.5 ${
      isActive
        ? 'text-foreground bg-background border border-border shadow-lg shadow-black/5 font-semibold'
        : 'text-muted-foreground hover:text-foreground hover:bg-background border border-transparent hover:border-border'
    }`;

  const getInitials = (name?: string) => {
    if (!name) return 'U';
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="h-16 border-b border-border bg-background sticky top-0 z-50">
        <div className="h-full max-w-[1600px] mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <NavLink to={ROUTES.PROTECTED.DASHBOARD} className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary flex items-center justify-center shadow-lg shadow-black/5 hover:shadow-black/5 transition-all duration-300 hover:scale-105">
                <Video className="w-4 h-4 text-primary-foreground" />
              </div>
              <div>
                <span className="text-lg font-bold text-foreground tracking-tight">Morphly</span>
                <p className="text-[10px] text-muted-foreground -mt-0.5 tracking-wide">AI Streaming Platform</p>
              </div>
            </NavLink>
          </div>

          <nav className="flex items-center gap-1.5">
            {navItems.map(({ path, label, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                end={path === ROUTES.PROTECTED.DASHBOARD}
                className={getNavLinkClass}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-all duration-200 ${
              sessionStatus === 'LIVE'
                ? 'bg-danger-soft border-destructive/30'
                : 'bg-background border-border'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${sessionStatus === 'LIVE' ? 'bg-destructive animate-pulse' : 'bg-background'}`} />
              <span className={`text-[10px] font-bold uppercase tracking-wider ${sessionStatus === 'LIVE' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {sessionStatus}
              </span>
            </div>
            <NavLink
              to={ROUTES.PROTECTED.WALLET}
              className={({ isActive }) =>
                `flex items-center gap-2 px-4 py-2 rounded-xl border transition-all duration-200 shadow-lg shadow-black/5 ${
                  isActive 
                    ? 'bg-accent border-primary/30 hover:border-primary/50'
                    : 'bg-background border-border hover:border-border hover:bg-background'
                }`
              }
            >
              <Coins className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-sm font-bold text-foreground tracking-tight">{Math.round(credits).toLocaleString()}</span>
              <span className="px-2 py-0.5 text-[9px] font-bold text-primary bg-accent rounded-full tracking-wide border border-primary/20">CREDITS</span>
            </NavLink>
            <Separator orientation="vertical" className="h-6 bg-background" />
            <div className="relative group">
              <button className="flex items-center gap-2 p-1 rounded-xl hover:bg-background transition-all duration-200">
                <Avatar className="w-8 h-8 ring-2 ring-ring ring-offset-2 ring-offset-background">
                  <AvatarFallback className="bg-gradient-to-br from-background to-background text-xs font-semibold text-foreground">
                    {getInitials(user?.name)}
                  </AvatarFallback>
                </Avatar>
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <div className="absolute right-0 top-full mt-3 w-56 bg-background border border-border rounded-xl shadow-2xl shadow-black/5 py-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 backdrop-blur-xl">
                <div className="px-5 py-4 border-b border-border">
                  <p className="text-sm font-semibold text-foreground">{user?.name || 'User'}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{user?.email || 'user@example.com'}</p>
                </div>
                <button
                  onClick={logout}
                  className="w-full px-5 py-3 text-sm text-left text-muted-foreground hover:text-foreground hover:bg-background flex items-center gap-3 transition-colors duration-150"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-8">
        {children}
      </main>
    </div>
  );
}
