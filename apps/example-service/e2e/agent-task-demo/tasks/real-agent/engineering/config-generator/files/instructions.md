Generate a production deployment configuration based on the attached template and requirements.

1. Read the template.yaml to understand the config structure
2. Read the requirements.txt to understand the resource needs
3. Use the compute tool to calculate:
   - Total CPU cores needed
   - Total memory needed
   - Monthly cost estimate
   - Number of replicas for high availability
4. Fill in the template with computed values
5. Use check_rules to verify the config meets the stated constraints

Requirements must be met within the stated budget.
