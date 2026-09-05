import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Home, ArrowLeft } from 'lucide-react';

function NotFound() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-background flex flex-col items-center justify-center text-center px-4">
      <div className="mb-8">
        <h1 className="text-[150px] font-black text-primary leading-none mb-4">
          404
        </h1>
        <div className="w-16 h-1 bg-gradient-to-r from-primary to-primary rounded-full mx-auto mb-6" />
      </div>
      <h2 className="text-2xl font-bold text-foreground mb-3">Page Not Found</h2>
      <p className="text-muted-foreground mb-8 max-w-md">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Link to="/dashboard">
          <Button className="h-11 px-6 bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary text-primary-foreground font-medium rounded-xl shadow-lg shadow-black/5">
            <Home className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
        <Button 
          variant="outline" 
          onClick={() => window.history.back()}
          className="h-11 px-6 border-border text-muted-foreground hover:text-foreground hover:bg-background rounded-xl"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Go Back
        </Button>
      </div>
    </div>
  );
}

export default NotFound;
