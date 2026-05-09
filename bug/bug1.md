bug：多选题渲染出错
二、run_20260509_022257.json 处理失败原因                                                                                                           
                                           
  根本原因：大模型生成 progress_form_template 时，将多选题（multi_choice）错误标注为 text                                                             
  类型，导致前端无法正确渲染选项，用户无法完成必填题，问卷提交被阻断。                                                                                
                                                                                                                                                      
  具体问题                                                                                                                                            
                                                                                                                                                      
  JSON 中 report.progress_form_template.questions 有 3 道题存在类型错误：                                                                             
                                  
  ┌──────┬────────────────────────────────────┬──────────┬──────────────┬──────────┐                                                                  
  │ 题号 │                问题                │ 实际类型 │   应为类型   │ required │
  ├──────┼────────────────────────────────────┼──────────┼──────────────┼──────────┤                                                                  
  │ q2   │ 雅各布行列式计算需要哪些前置知识？ │ text     │ multi_choice │ ✅ 必填  │
  ├──────┼────────────────────────────────────┼──────────┼──────────────┼──────────┤                                                                  
  │ q4   │ 完整知识框架包含哪些核心模块？     │ text     │ multi_choice │ ✅ 必填  │
  ├──────┼────────────────────────────────────┼──────────┼──────────────┼──────────┤                                                                  
  │ q8   │ 学习中遇到的主要困惑有哪些？       │ text     │ multi_choice │ ✅ 必填  │
  └──────┴────────────────────────────────────┴──────────┴──────────────┴──────────┘                                                                  
                                         
  这三道题都有 options 数组（4-5 个选项），问题措辞也是"哪些"（多选语义），但 LLM 输出时将 type 写成了 text。                                         
                                                                                                                                                      
  失败链路                                                                                                                                            
                                                                                                                                                      
  LLM 生成 progress_form_template                                                                                                                     
    → q2/q4/q8 type=text（应为 multi_choice）
    → 前端 renderProgressQuestion() 对 text 类型只渲染 <textarea>，options 被完全忽略                                                                 
    → 用户看到空白文本框，不知道有选项可选
    → 用户填写文本后提交，或因 required 校验失败无法提交                                                                                              
    → collectFormData() 对 text 类型收集 textarea.value，而非 checkbox 数组
    → 后端收到的 responses 格式与预期不符，评估质量下降                                                                                               
                                                                                                                                                      
  次要问题                                                                                                                                            
                                                                                                                                                      
  report.profile 存在双层嵌套结构（profile.profile_version / profile.profile / profile.confidence），后端 evaluate_learning 将整个外层对象传给        
  LLM，LLM 需要自行解析内层 profile.profile 才能获取真实画像数据，增加了评估出错的概率。