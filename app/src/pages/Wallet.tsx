import { ArrowDownLeft, ArrowUpRight, Coins } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';

function Wallet() {
  const { credits, transactions } = useApp();
  const navigate = useNavigate();

  // Calculate estimated time from credits
  const estimatedSeconds = credits / 2;
  const estimatedMinutes = Math.floor(estimatedSeconds / 60);
  const estimatedRemainingSeconds = estimatedSeconds % 60;

  return (
    <div className="max-w-[800px]">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground mb-2 tracking-tight">Wallet</h1>
        <p className="text-sm text-muted-foreground">Manage your credits and view transactions</p>
      </div>

      <Card className="bg-gradient-to-br from-background to-background border-border overflow-hidden rounded-2xl shadow-2xl shadow-black/5 mb-6">
        <CardHeader className="pb-4 border-b border-border">
          <CardTitle className="text-sm font-medium text-muted-foreground">Available Credits</CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-accent flex items-center justify-center">
              <Coins className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-4xl font-semibold text-foreground">{Math.round(credits).toLocaleString()}</p>
              <p className="text-sm text-muted-foreground">credits</p>
            </div>
          </div>
          <div className="bg-background rounded-lg p-4 border border-border">
            <p className="text-sm text-muted-foreground">
              Estimated stream time: <span className="text-foreground font-semibold">~{estimatedMinutes}m {Math.round(estimatedRemainingSeconds)}s</span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">2 credits per second</p>
          </div>
          <Button 
            onClick={() => navigate('/settings')}
            className="w-full bg-primary hover:bg-primary-hover text-primary-foreground font-medium"
          >
            Recharge
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-gradient-to-br from-background to-background border-border overflow-hidden rounded-2xl shadow-2xl shadow-black/5">
        <CardHeader className="pb-4 border-b border-border">
          <CardTitle className="text-sm font-medium text-muted-foreground">Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No transactions found.
            </div>
          ) : (
            <div className="space-y-4 pt-4">
              {transactions.map((tx, index) => (
                <div key={tx.id}>
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${tx.type === 'credit' ? 'bg-success-soft' : 'bg-danger-soft'}`}>
                        {tx.type === 'credit' ? (
                          <ArrowDownLeft className="w-5 h-5 text-success" />
                        ) : (
                          <ArrowUpRight className="w-5 h-5 text-destructive" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {tx.description || (tx.type === 'credit' ? 'Credits purchased' : 'Stream usage')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(tx.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-semibold ${tx.type === 'credit' ? 'text-success' : 'text-destructive'}`}>
                        {tx.type === 'debit' ? '-' : '+'}{tx.credits?.toLocaleString() || 0} credits
                      </p>
                      <p className="text-xs text-muted-foreground">Completed</p>
                    </div>
                  </div>
                  {index < transactions.length - 1 && <Separator className="bg-background" />}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default Wallet;
