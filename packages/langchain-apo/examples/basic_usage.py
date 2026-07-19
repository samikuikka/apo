from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

from apo_langchain import ApoCallbackHandler

handler = ApoCallbackHandler(
    endpoint="http://localhost:8000",
    project="langchain-demo",
)

llm = ChatOpenAI(model="gpt-4o-mini", callbacks=[handler])
result = llm.invoke([HumanMessage(content="Tell me a joke.")])
print(result.content)

handler.flush()
print("Trace sent! Check http://localhost:3000 for 'langchain-demo'")
