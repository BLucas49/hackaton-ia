import torch
import json
import os
from transformers import (
    AutoTokenizer, AutoModelForCausalLM, 
    TrainingArguments, Trainer, DataCollatorForLanguageModeling,
    BitsAndBytesConfig
)
from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training
from datasets import Dataset
from datasets import load_dataset

ds = load_dataset("ruslanmv/ai-medical-chatbot")

class MedicalModelTrainer:
    def __init__(self, model_name="microsoft/Phi-3-mini-4k-instruct", dataset=ds):
        self.model_name = model_name
        self.dataset = dataset
        self.tokenizer = None
        self.model = None
        
    def setup_model(self):
        print(f"🤖 Loading model: {self.model_name}")
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name, trust_remote_code=True)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = "right"
        
        if torch.cuda.is_available():
            quantization_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4"
            )
            print("🔧 4-bit quantization enabled")
        else:
            quantization_config = None
            print("💻 Running in CPU mode")
            
        model_kwargs = {
            "torch_dtype": torch.float16 if torch.cuda.is_available() else torch.float32,
            "trust_remote_code": True,
            "low_cpu_mem_usage": True,
        }
        
        if quantization_config:
            model_kwargs["quantization_config"] = quantization_config
            model_kwargs["device_map"] = "auto"
        
        self.model = AutoModelForCausalLM.from_pretrained(self.model_name, **model_kwargs)
        
        if not quantization_config and torch.cuda.is_available():
            self.model = self.model.cuda()
            
        if len(self.tokenizer) > self.model.config.vocab_size:
            self.model.resize_token_embeddings(len(self.tokenizer))
            
        if quantization_config:
            self.model = prepare_model_for_kbit_training(self.model)
            
        lora_config = LoraConfig(
            r=16,
            lora_alpha=32,
            target_modules=["qkv_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_dropout=0.1,
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )
        
        self.model = get_peft_model(self.model, lora_config)
        print(f"✅ Model ready with {self.model.num_parameters()} trainable parameters")
        
    def get_training_split(self):
        # Le dataset est déjà un objet Hugging Face. On accède directement à la partie 'train'.
        # La colonne 'text' contient déjà les conversations formatées.
        print(f"📊 Using 'train' split with {len(self.dataset['train'])} conversations")
        return self.dataset['train']

    def prepare_training_dataset(self, texts):
        print("🔧 Tokenizing dataset...")
        def tokenize_function(examples):
            tokenized = self.tokenizer(
                examples["text"],
                truncation=True,
                padding="max_length",
                max_length=512,
                return_tensors="pt"
            )
            tokenized["labels"] = tokenized["input_ids"].clone()
            return tokenized
        
        return texts.map(tokenize_function, batched=True, remove_columns=["text"])
    
    def train_model(self, dataset, output_dir="./medical_model_trained", epochs=1):
        print("🚀 Starting model training...")
        training_args = TrainingArguments(
            output_dir=output_dir,
            num_train_epochs=epochs, # Réduit à 1 pour le hackathon
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            learning_rate=2e-4,
            warmup_steps=10,
            logging_steps=10,
            save_strategy="no",
            no_cuda=not torch.cuda.is_available(),
            fp16=torch.cuda.is_available(),
        )
        
        trainer = Trainer(
            model=self.model,
            args=training_args,
            train_dataset=dataset,
            processing_class=self.tokenizer,
            data_collator=DataCollatorForLanguageModeling(tokenizer=self.tokenizer, mlm=False),
        )
        
        print("⏳ Training in progress... Grab a coffee ☕")
        trainer.train()
        trainer.save_model()
        print(f"✅ Training completed! Model saved to {output_dir}")
    
    def test_model(self):
        test_prompts = [
            "Quels sont les symptômes principaux de la grippe ?",
            "Comment puis-je soulager une migraine rapidement ?"
        ]
        
        print("\n🧪 Testing trained medical model:")
        print("-" * 50)
        self.model.eval()
        for prompt in test_prompts:
            print(f"\n👤 Patient: {prompt}")
            formatted_input = f"<|user|>\n{prompt}<|end|>\n<|assistant|>\n"
            inputs = self.tokenizer(formatted_input, return_tensors="pt", truncation=True, max_length=512)
            if torch.cuda.is_available():
                inputs = {k: v.cuda() for k, v in inputs.items()}
                
            with torch.no_grad():
                outputs = self.model.generate(
                    **inputs,
                    max_new_tokens=150,
                    temperature=0.3, # Température basse pour avis médical
                    pad_token_id=self.tokenizer.eos_token_id,
                )
            
            response = self.tokenizer.decode(outputs[0][inputs['input_ids'].shape[1]:], skip_special_tokens=True).strip()
            if response.endswith("<|end|>"): response = response[:-7].strip()
            print(f"🤖 Dr. IA: {response}")
    
    def run_training(self):
        self.setup_model()
        training_data = self.get_training_split()
        training_dataset = self.prepare_training_dataset(training_data)
        self.train_model(training_dataset)
        self.test_model()

# Lancement
trainer = MedicalModelTrainer()
trainer.run_training()