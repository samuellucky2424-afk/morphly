import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useUI } from '@/context/UIContext';

export default function Layout() {
  const { sidebarCollapsed } = useUI();

  return (
    <div className="flex min-h-screen bg-[#09090b]">
      <Sidebar />
      <main 
        className={`flex-1 transition-all duration-300 ${
          sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'
        }`}
      >
        <div className="p-6 lg:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
