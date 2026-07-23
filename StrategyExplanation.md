Gold Strategy

The setup — "Asian Range Breakout Continuation"
1. Build a box — During the quiet Asian hours (00:00–07:00 UTC), record gold's highest and lowest price. That's your "Asian range."
2. Wait for the breakout — During the NY session (12:30–15:30 UTC), watch for the first M5 candle that punches clearly through the top or bottom of that box (by at least 100 pips for gold) and closes beyond it.
3. Confirm the trend — Only take the breakout if it aligns with the H1 trend:
- Break above the box → only take if H1 is bullish
- Break below the box → only take if H1 is bearish
  The trade
- Entry — Place a stop order just beyond the broken level (Asian high + 10 pips for a buy, Asian low − 10 pips for a sell).
- Stop loss — Below the break candle's low (for a buy) or above its high (for a sell), plus a 10-pip buffer.
- Take profit — Risk × 3.0 (your RR ratio). So if your stop is 300 pips away, your target is 900 pips.
  In short: When price breaks out of the overnight range and the bigger trend agrees, ride the momentum with a 3:1 reward-to-risk ratio.


FX Strategy

The setup — "Asian Range Breakout Continuation" (FX)

     1. Build a box — During Asian hours (00:00–07:00 UTC), record the pair's highest and lowest price. That's your "Asian range."                                                                                                                        
                                                                                                                                                                                                                                                          
     2. Wait for the breakout — During NY session (12:30–15:30 UTC), watch for the first M5 candle that breaks clearly through the box (by at least 3 pips) and closes beyond it.                                                                         
                                                                                                                                                                                                                                                          
     3. Confirm the trend — Only take the breakout if it aligns with the H1 trend:                                                                                                                                                                        
        - Break above the box → only take if H1 is bullish                                                                                                                                                                                                
        - Break below the box → only take if H1 is bearish                                                                                                                                                                                                
                                                                                                                                                                                                                                                          
     The trade                                                                                                                                                                                                                                            
                                                                                                                                                                                                                                                          
     - Entry — Place a stop order just beyond the broken level (Asian high + 0.5 pips for a buy, Asian low − 0.5 pips for a sell).                                                                                                                        
     - Stop loss — Below the break candle's low (for a buy) or above its high (for a sell), plus a 0.5-pip buffer.                                                                                                                                        
     - Take profit — Risk × 1.5. So if your stop is 10 pips away, your target is 15 pips.                                                                                                                                                                 
                                                                                                                                                                                                                                                          
     Key differences from gold:                                                                                                                                                                                                                           
                                                                                                                                                                                                                                                          
     - Much tighter thresholds (3 pips vs 100 for gold)                                                                                                                                                                                                   
     - Lower RR ratio (1.5:1 vs 3:1)                                                                                                                                                                                                                      
     - H1 trend alignment is required (gold has it disabled)                                                                                                                                                                                              
     - Max 1 trade per session (gold allows 2)                                                                                                                                                                                                            
                                                                                                                                                                                                                                                          
     So for FX pairs like EUR/USD, you're looking at tight, controlled scalps with a 1.5:1 reward-to-risk ratio, only when the bigger trend agrees.                                                                                                       

The setup — "London Fake-Break Reversal"
1. Build a box — During the quiet Asian hours (00:00–07:00 UTC), record the pair's highest and lowest price. That's your "Asian range."
2. Wait for a fake breakout — During the London session (7:00–9:00 UTC), watch for price to poke above the top or below the bottom of the box by at least 4 pips.
3. Wait for it to fail — The price must then close back inside the box within 2 candles (10 minutes). This tells us the breakout was fake — a trap.
4. Check the trend — The H1 trend filter is set to "all," meaning we don't care about the bigger trend here. We're fading the trap regardless.
   The trade
- Entry — Enter immediately at market price when the confirmation candle closes back inside the box.
- Stop loss — Beyond the extreme of the whole breakout move (highest high or lowest low from the break candle through the confirmation candle), plus a 0.5-pip buffer.
- Take profit — The opposite side of the Asian range. If price broke above and came back in, we sell and target the Asian low. If it broke below and came back in, we buy and target the Asian high.
  The idea in one sentence: When big players push price out of the range to trigger stop losses, then pull it back in, we ride the reversal back to the other side of the range.
  Key differences from the NY/gold strategy:
- We're fading a failed breakout, not riding a successful one
- H1 trend doesn't matter
- Targets the opposite side of the box (not a fixed RR ratio)
- Only runs Tue/Wed/Thu (London is choppy on Mon/Fri)
- Max 1 loss per day — if it hits, we're done for the day


******* Can we add this to gold?
The only thing to note is that NY_ASIAN_BLOCK_ON_PRIOR_BREAK=false in your .env, which means the strategy will allow a second entry if the Asian range gets broken again after the first trade (unlike the default behavior). So you could potentially get more than 1 NY trade per day if the setup repeats.