# Production Prompt Management: Lessons from Deploying LLMs at Scale

## Authors: Raj Patel, Lisa Wong - Stripe AI Platform Team

## Abstract
We share practical lessons from managing 200+ production LLM prompts serving 100M+ daily requests at Stripe. Our prompt management system reduced prompt-related incidents by 73% and improved mean-time-to-resolution from 4 hours to 12 minutes.

## Key Findings

### Performance Benchmarks
- Production prompt drift: performance degrades 2-5% per month without monitoring
- A/B testing prompts in production revealed 15% of "improved" prompts actually regressed on edge cases
- Latency-optimized prompts (shorter, more direct) achieved 40% lower p99 latency with only 3% accuracy loss

### Cost-Effectiveness Analysis
- Version-controlled prompts with rollback capability prevented $2.1M in potential revenue loss
- Automated regression testing catches 89% of prompt regressions before production impact
- Prompt caching at the application layer reduced API costs by 55%
- Total platform cost: $0.003 per optimized request vs $0.008 for unoptimized

### Practical Recommendations
1. **Treat prompts like code**: version control, PR reviews, CI/CD pipelines
2. **Monitor in production**: track accuracy, latency, and cost metrics per prompt
3. **Gradual rollouts**: canary 5% -> 25% -> 100% with automated rollback
4. **Prompt templates**: parameterized prompts reduce duplication from 200+ to ~40 templates
5. **Regular re-evaluation**: monthly benchmark runs against curated test sets

## On Academic Benchmarks
We found that improvements on academic benchmarks (MMLU, etc.) rarely translate directly to production improvements. Smith et al.'s 23-41% accuracy gains on MMLU corresponded to only 8-15% improvement in our production metrics. The gap is due to production prompts being already well-optimized and production tasks being more nuanced than benchmark tasks.
